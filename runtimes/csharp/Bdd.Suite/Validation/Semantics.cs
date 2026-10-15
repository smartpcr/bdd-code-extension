using System.Globalization;
using Bdd.Suite.Diagnostics;
using Bdd.Suite.Extensions;
using Bdd.Suite.Model;
using Bdd.Suite.Schema;
using Bdd.Suite.Text;
using Bdd.Suite.Values;
using Bdd.Suite.Walking;

namespace Bdd.Suite.Validation;

/// <summary>Whether a parameter has a value anywhere, and where it was
/// declared.</summary>
public sealed class ParamDeclaration
{
    public bool HasValue { get; set; }
    public string Pointer { get; set; } = string.Empty;
}

/// <summary>A local declaration that reuses an imported name.</summary>
public sealed record Collision(string Kind, string Name, string Source, string Pointer);

/// <summary>What a suite's imports contribute, and what they collide with.</summary>
public sealed class Library
{
    public Dictionary<string, ParamDeclaration> Params { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, string> Vars { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, OrderedMap> MetaSteps { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, string> Defaults { get; } = new(StringComparer.Ordinal);
    public List<Collision> Collisions { get; } = [];
    public List<Diagnostic> Diagnostics { get; } = [];

    /// <summary>Every import the suite names that resolves to a file, in
    /// reading order, so an extension's lint rule can see what a suite brings
    /// in. (A rule about one particular library, such as a product's shared
    /// checks, is an extension's, not the core's.)</summary>
    public List<SuiteImport> Imports { get; } = [];
}

/// <summary>
/// E201 to E213: what a schema cannot see.
///
/// Duplicate names, limits and their ceilings, meta steps and their cycles,
/// imports and what they shadow, parameters with no value anywhere, the Gherkin
/// keyword order and the table rules. All of it needs the parsed model and the
/// catalog rather than the file, which is why it is its own level (DEC-Y05).
/// </summary>
public static class Semantics
{
    /// <summary>Everything a library may declare. Anything else runs, and a
    /// library does not run (DEC-Y17).</summary>
    private static readonly string[] LibraryKeys =
        ["params", "vars", "metaSteps", "defaults", "description", "schemaVersion"];

    /// <summary>The ceiling on any limit. A stricter, tag-based ceiling is an
    /// extension's rule (ExtensionRules), not the core's.</summary>
    private const long LimitCeilingSec = 14400;

    private static readonly string[] GherkinKeywords = ["given", "when", "then", "and"];

    private sealed record MetaDefinition(OrderedMap Definition, string Pointer);

    private static List<string> MapKeys(OrderedMap? held, string key) =>
        held?.Map(key)?.Keys.ToList() ?? [];

    /// <summary>Read the libraries a suite imports, depth first and in
    /// order.</summary>
    public static Library Imports(SuiteDocument document, string file, string filePath)
    {
        var library = new Library();
        if (document.Value is not OrderedMap suite)
        {
            return library;
        }
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { Path.GetFullPath(filePath) };
        var directory = Path.GetDirectoryName(Path.GetFullPath(filePath)) ?? ".";

        var items = suite.List("imports") ?? [];
        for (var index = 0; index < items.Count; index++)
        {
            if (items[index] is not string name || name.Length == 0)
            {
                continue;
            }
            var pointer = string.Create(CultureInfo.InvariantCulture, $"/imports/{index}");
            var position = document.At(pointer).Value;
            var path = Path.Combine(directory, name);
            var full = Path.GetFullPath(path);
            if (visited.Contains(full))
            {
                library.Diagnostics.Add(Diagnostic.Error("E207", file, position,
                    string.Create(CultureInfo.InvariantCulture, $"Import {name} forms a cycle.")));
                continue;
            }
            if (!File.Exists(path))
            {
                library.Diagnostics.Add(Diagnostic.Error("E301", file, position,
                    string.Create(CultureInfo.InvariantCulture, $"Import {name} does not exist.")));
                continue;
            }
            visited.Add(full);
            library.Imports.Add(new SuiteImport(name, pointer, full));
            OrderedMap imported;
            try
            {
                imported = SuiteDocument.Load(File.ReadAllText(path)).Value as OrderedMap
                    ?? throw new LoadException("the import does not hold a YAML mapping.", Position.Start);
            }
            catch (Exception failure) when (failure is LoadException or IOException)
            {
                library.Diagnostics.Add(Diagnostic.Error("E100", file, position,
                    string.Create(CultureInfo.InvariantCulture,
                        $"Import {name} is not valid YAML: {failure.Message}")));
                continue;
            }

            foreach (var key in imported.Keys)
            {
                if (!LibraryKeys.Contains(key, StringComparer.Ordinal))
                {
                    library.Diagnostics.Add(Diagnostic.Error("E211", file, position,
                        string.Create(CultureInfo.InvariantCulture,
                            $"Import {name} declares {key}. A library declares {string.Join(", ", LibraryKeys)} and nothing that runs.")));
                }
            }
            foreach (var param in Walk.Entries(imported, "params"))
            {
                if (param is null)
                {
                    continue;
                }
                library.Params[param.Text("name")] =
                    new ParamDeclaration { HasValue = param.Present("default") || param.Present("input"), Pointer = pointer };
            }
            foreach (var variable in MapKeys(imported, "vars"))
            {
                library.Vars[variable] = name;
            }
            foreach (var meta in Walk.Entries(imported, "metaSteps"))
            {
                if (meta is not null)
                {
                    library.MetaSteps[meta.Text("name")] = meta;
                }
            }
            foreach (var key in MapKeys(imported, "defaults"))
            {
                library.Defaults[key] = name;
            }
        }

        // A local declaration that reuses an imported name has to say so.
        var metas = Walk.Entries(suite, "metaSteps");
        for (var index = 0; index < metas.Count; index++)
        {
            var meta = metas[index];
            if (meta is null)
            {
                continue;
            }
            var name = meta.Text("name");
            if (library.MetaSteps.ContainsKey(name) && !meta.Present("override"))
            {
                library.Collisions.Add(new Collision("Meta step", name, "library",
                    string.Create(CultureInfo.InvariantCulture, $"/metaSteps/{index}/name")));
            }
        }
        var declaredParams = Walk.Entries(suite, "params");
        for (var index = 0; index < declaredParams.Count; index++)
        {
            var param = declaredParams[index];
            if (param is null)
            {
                continue;
            }
            var name = param.Text("name");
            if (library.Params.ContainsKey(name) && !param.Present("override"))
            {
                library.Collisions.Add(new Collision("Parameter", name, "library",
                    string.Create(CultureInfo.InvariantCulture, $"/params/{index}/name")));
            }
        }
        foreach (var name in MapKeys(suite, "vars"))
        {
            if (library.Vars.TryGetValue(name, out var source))
            {
                library.Collisions.Add(new Collision("Variable", name, source,
                    "/vars/" + SuiteDocument.Escape(name)));
            }
        }
        return library;
    }

    /// <summary>How deep one meta step nests, or the cycle it is part of.</summary>
    private static (int Depth, List<string>? Cycle) MetaDepth(
        string name, Dictionary<string, MetaDefinition> definitions, List<string> path)
    {
        if (path.Contains(name, StringComparer.Ordinal))
        {
            return (path.Count, [.. path, name]);
        }
        if (!definitions.TryGetValue(name, out var definition))
        {
            return (path.Count, null);
        }
        path.Add(name);
        var deepest = path.Count;
        foreach (var step in Walk.Entries(definition.Definition, "steps"))
        {
            var used = step?.Text("meta") ?? string.Empty;
            if (used.Length == 0)
            {
                continue;
            }
            var (depth, cycle) = MetaDepth(used, definitions, path);
            if (cycle is not null)
            {
                path.RemoveAt(path.Count - 1);
                return (depth, cycle);
            }
            deepest = Math.Max(deepest, depth);
        }
        path.RemoveAt(path.Count - 1);
        return (deepest, null);
    }

    /// <summary>E204: an assertion that compares nothing, wherever it is
    /// written.</summary>
    private static List<Diagnostic> AssertionShape(
        object? assertions, string pointer, string whereItIs,
        SuiteSchema schema, SuiteDocument document, string file)
    {
        var found = new List<Diagnostic>();
        if (assertions is not List<object?> list)
        {
            return found;
        }
        for (var index = 0; index < list.Count; index++)
        {
            if (list[index] is not OrderedMap assertion)
            {
                continue;
            }
            var operators = assertion.Keys
                .Where(key => schema.AssertOperators.Contains(key, StringComparer.Ordinal)).ToList();
            var position = document.At(string.Create(CultureInfo.InvariantCulture, $"{pointer}/{index}")).Key;
            if (operators.Count == 0 && assertion.Present("var"))
            {
                found.Add(Diagnostic.Error("E204", file, position, string.Create(CultureInfo.InvariantCulture,
                        $"The assertion on {assertion.Text("var")} in {whereItIs} names a subject and no comparison, so it asserts nothing."))
                    .Suggest("One of: " + string.Join(", ", schema.AssertOperators)));
            }
            else if (!assertion.Present("var") && !assertion.Present("script"))
            {
                found.Add(Diagnostic.Error("E204", file, position, string.Create(CultureInfo.InvariantCulture,
                    $"An assertion in {whereItIs} names no subject. Add var, or use script.")));
            }
        }
        return found;
    }

    /// <summary>E213: a table whose rows do not agree, or repeat.</summary>
    private static List<Diagnostic> TableRules(
        object? table, string pointer, string whereItIs, SuiteDocument document, string file)
    {
        var found = new List<Diagnostic>();
        if (table is not List<object?> list)
        {
            return found;
        }
        if (!list.Any(row => row is not null))
        {
            found.Add(Diagnostic.Error("E213", file, document.At(pointer).Key,
                string.Create(CultureInfo.InvariantCulture,
                    $"The table on {whereItIs} has no rows, so the step it drives would never run.")));
            return found;
        }
        var columns = Walk.TableColumns(table);
        var seen = new Dictionary<string, int>(StringComparer.Ordinal);
        for (var index = 0; index < list.Count; index++)
        {
            if (list[index] is not OrderedMap row)
            {
                continue;
            }
            var rowColumns = row.Keys;
            var missing = columns.Where(column => !rowColumns.Contains(column, StringComparer.Ordinal)).ToList();
            var extra = rowColumns.Where(column => !columns.Contains(column, StringComparer.Ordinal)).ToList();
            var position = document.At(string.Create(CultureInfo.InvariantCulture, $"{pointer}/{index}")).Key;
            if (missing.Count > 0 || extra.Count > 0)
            {
                var parts = missing.Select(name => name + " is missing")
                    .Concat(extra.Select(name => name + " is extra"));
                found.Add(Diagnostic.Error("E213", file, position, string.Create(CultureInfo.InvariantCulture,
                    $"Row {index + 1} of the table on {whereItIs} does not declare the same columns as the first row: {string.Join(", ", parts)}.")));
            }
            var sorted = rowColumns.ToList();
            sorted.Sort(StringComparer.Ordinal);
            var signature = string.Join('\u0001', sorted.Select(column => column + "=" + Value.Text(row.Value(column))));
            if (seen.TryGetValue(signature, out var first))
            {
                found.Add(Diagnostic.Error("E213", file, position, string.Create(CultureInfo.InvariantCulture,
                    $"Row {index + 1} of the table on {whereItIs} repeats row {first}, which would give two iterations the same name.")));
                continue;
            }
            seen[signature] = index + 1;
        }
        return found;
    }

    /// <summary>E212, E213 and W304: the keywords are used in order, and a list
    /// is labelled all the way through or not at all.</summary>
    private static List<Diagnostic> ScenarioRules(SuiteDocument document, string file)
    {
        var found = new List<Diagnostic>();
        if (document.Value is not OrderedMap suite)
        {
            return found;
        }
        static int Rank(string keyword) => keyword switch
        {
            "given" => 1,
            "when" => 2,
            "then" => 3,
            _ => 0,
        };
        foreach (var list in Walk.StepLists(suite))
        {
            var started = false;
            var highest = 0;
            var labelled = 0;
            var total = 0;
            for (var index = 0; index < list.Steps.Count; index++)
            {
                if (list.Steps[index] is not OrderedMap step)
                {
                    continue;
                }
                var stepPointer = string.Create(CultureInfo.InvariantCulture, $"{list.Pointer}/{index}");
                var foundKeywords = step.Keys
                    .Where(key => GherkinKeywords.Contains(key, StringComparer.Ordinal)).ToList();
                // A meta use site with no keyword of its own stands for the steps
                // of its definition, and those carry theirs.
                if (foundKeywords.Count > 0 || !step.Present("meta"))
                {
                    total++;
                }
                if (foundKeywords.Count > 1)
                {
                    found.Add(Diagnostic.Error("E212", file,
                        document.At(stepPointer + "/" + foundKeywords[1]).Key,
                        string.Create(CultureInfo.InvariantCulture,
                            $"Step {index + 1} of {list.Name} carries {string.Join(" and ", foundKeywords)}. A step carries one Gherkin keyword.")));
                }
                if (foundKeywords.Count > 0)
                {
                    var keyword = foundKeywords[0];
                    labelled++;
                    if (string.Equals(keyword, "and", StringComparison.Ordinal))
                    {
                        if (!started)
                        {
                            found.Add(Diagnostic.Error("E212", file, document.At(stepPointer + "/and").Key,
                                    string.Create(CultureInfo.InvariantCulture,
                                        $"Step {index + 1} of {list.Name} is an and with nothing before it to continue."))
                                .Suggest("Start the list with given, when or then."));
                        }
                    }
                    else
                    {
                        if (Rank(keyword) < highest)
                        {
                            var before = highest switch { 1 => "given", 2 => "when", _ => "then" };
                            found.Add(Diagnostic.Error("E212", file,
                                    document.At(stepPointer + "/" + keyword).Key,
                                    string.Create(CultureInfo.InvariantCulture,
                                        $"Step {index + 1} of {list.Name} is a {keyword} after a {before}. The order is given, then when, then then."))
                                .Suggest("Continue with and, or move the step."));
                        }
                        highest = Math.Max(highest, Rank(keyword));
                        started = true;
                    }
                }
                if (step.Present("table"))
                {
                    found.AddRange(TableRules(step.Value("table"), stepPointer + "/table",
                        string.Create(CultureInfo.InvariantCulture, $"step {index + 1} of {list.Name}"),
                        document, file));
                    if (list.Case is not null && list.Case.Present("examples"))
                    {
                        found.Add(Diagnostic.Error("E213", file, document.At(stepPointer + "/table").Key,
                                string.Create(CultureInfo.InvariantCulture,
                                    $"Step {index + 1} of {list.Name} carries a table inside a case that already carries examples. There is one row namespace, and two row scopes would shadow each other."))
                            .Suggest("Keep the table and drop the examples, or the other way round."));
                    }
                }
            }
            if (labelled > 0 && labelled < total)
            {
                found.Add(Diagnostic.Warning("W304", file, document.At(list.Pointer).Key,
                    string.Create(CultureInfo.InvariantCulture,
                        $"{list.Name} labels {labelled} of its {total} steps with a Gherkin keyword. Label all of them or none.")));
            }
        }
        var cases = Walk.Entries(suite, "tests");
        for (var index = 0; index < cases.Count; index++)
        {
            var held = cases[index];
            if (held is null || !held.Present("examples"))
            {
                continue;
            }
            found.AddRange(TableRules(held.Value("examples"),
                string.Create(CultureInfo.InvariantCulture, $"/tests/{index}/examples"),
                "case " + held.Text("name"), document, file));
        }
        return found;
    }

    /// <summary>E205: every declared limit is a positive number under its
    /// ceiling.</summary>
    private static List<Diagnostic> Limits(SuiteDocument document, string file)
    {
        var found = new List<Diagnostic>();
        if (document.Value is not OrderedMap suite)
        {
            return found;
        }
        var declared = new List<(string Pointer, string Name, object? Value, string Scope)>();
        foreach (var key in new[]
                 {
                     "setupTimeoutSec", "beforeEachTimeoutSec", "afterEachTimeoutSec", "teardownTimeoutSec",
                 })
        {
            if (suite.Present(key))
            {
                declared.Add(("/" + key, key, suite.Value(key), "the suite"));
            }
        }
        if (suite.Map("defaults") is { } defaults)
        {
            foreach (var key in new[] { "timeoutSec", "cleanupTimeoutSec" })
            {
                if (defaults.Present(key))
                {
                    declared.Add(("/defaults/" + key, key, defaults.Value(key), "the suite defaults"));
                }
            }
        }
        var cases = Walk.Entries(suite, "tests");
        for (var index = 0; index < cases.Count; index++)
        {
            var held = cases[index];
            if (held is null)
            {
                continue;
            }
            foreach (var key in new[] { "timeoutSec", "cleanupTimeoutSec", "setupTimeoutSec" })
            {
                if (held.Present(key))
                {
                    declared.Add((string.Create(CultureInfo.InvariantCulture, $"/tests/{index}/{key}"),
                        key, held.Value(key), "case " + held.Text("name")));
                }
            }
        }

        foreach (var (pointer, name, value, scope) in declared)
        {
            const long ceiling = LimitCeilingSec;
            // A limit written as an expression is checked when it is evaluated,
            // and a limit of the wrong type has already been refused by the
            // schema.
            if (value is not long seconds)
            {
                continue;
            }
            if (seconds < 1 || seconds > ceiling)
            {
                found.Add(Diagnostic.Error("E205", file, document.At(pointer).Value,
                    string.Create(CultureInfo.InvariantCulture,
                        $"{name} on {scope} is {seconds} seconds, outside 1 to {ceiling}.")));
            }
        }
        return found;
    }

    /// <summary>The semantic pass.</summary>
    public static List<Diagnostic> Check(
        SuiteDocument document, string file, SuiteSchema schema, Library library,
        string binding, bool bindingCheck, IReadOnlyList<KeyValuePair<string, string>> commandLineParams,
        string envPrefix = Composite.DefaultEnvPrefix)
    {
        var found = new List<Diagnostic>();
        if (document.Value is not OrderedMap suite)
        {
            return found;
        }
        var cases = Walk.Entries(suite, "tests");

        // E202: two cases a report cannot tell apart.
        var seenCase = new HashSet<string>(StringComparer.Ordinal);
        for (var index = 0; index < cases.Count; index++)
        {
            var held = cases[index];
            if (held is null)
            {
                continue;
            }
            var name = held.Text("name");
            if (!seenCase.Add(name))
            {
                found.Add(Diagnostic.Error("E202", file,
                    document.At(string.Create(CultureInfo.InvariantCulture, $"/tests/{index}/name")).Value,
                    string.Create(CultureInfo.InvariantCulture, $"Case {name} is declared twice in this suite.")));
            }
        }

        // E203: one case capturing the same name twice.
        for (var index = 0; index < cases.Count; index++)
        {
            var held = cases[index];
            if (held is null)
            {
                continue;
            }
            var seenCapture = new HashSet<string>(StringComparer.Ordinal);
            foreach (var phase in Walk.CasePhases)
            {
                foreach (var entry in Walk.StepEntries(held.List(phase),
                             string.Create(CultureInfo.InvariantCulture, $"/tests/{index}/{phase}"), phase))
                {
                    var name = entry.Step.Text("captureAs");
                    if (name.Length == 0 || seenCapture.Add(name))
                    {
                        continue;
                    }
                    found.Add(Diagnostic.Error("E203", file,
                        document.At(entry.Pointer + "/captureAs").Value,
                        string.Create(CultureInfo.InvariantCulture,
                            $"Case {held.Text("name")} already captures {name}. The second would replace the first.")));
                }
            }
            found.AddRange(AssertionShape(held.Value("asserts"),
                string.Create(CultureInfo.InvariantCulture, $"/tests/{index}/asserts"),
                "case " + held.Text("name"), schema, document, file));
        }
        foreach (var entry in Walk.AllSteps(suite))
        {
            found.AddRange(AssertionShape(entry.Step.Value("asserts"),
                entry.Pointer + "/asserts", "a " + entry.Phase + " step", schema, document, file));
        }

        found.AddRange(Limits(document, file));
        found.AddRange(ScenarioRules(document, file));

        // E206, E207, E208: meta steps exist, do not form a cycle, and are used
        // with the parameters they declare.
        var definitions = new Dictionary<string, MetaDefinition>(StringComparer.Ordinal);
        var metas = Walk.Entries(suite, "metaSteps");
        for (var index = 0; index < metas.Count; index++)
        {
            if (metas[index] is not { } meta)
            {
                continue;
            }
            definitions[meta.Text("name")] = new MetaDefinition(meta,
                string.Create(CultureInfo.InvariantCulture, $"/metaSteps/{index}"));
        }
        foreach (var (name, meta) in library.MetaSteps.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            if (!definitions.ContainsKey(name))
            {
                definitions[name] = new MetaDefinition(meta, string.Empty);
            }
        }
        var names = definitions.Keys.ToList();
        names.Sort(StringComparer.Ordinal);
        foreach (var entry in Walk.AllSteps(suite))
        {
            var used = entry.Step.Text("meta");
            if (used.Length == 0)
            {
                continue;
            }
            if (!definitions.TryGetValue(used, out var definition))
            {
                found.Add(Diagnostic.Error("E206", file, document.At(entry.Pointer + "/meta").Value,
                        string.Create(CultureInfo.InvariantCulture,
                            $"No meta step named {used} is declared or imported."))
                    .Suggest(Spelling.Nearest(used, names, 2)));
                continue;
            }
            var declared = Walk.Entries(definition.Definition, "params")
                .Where(param => param is not null).Select(param => param!.Text("name")).ToList();
            var supplied = entry.Step.Map("with")?.Keys.ToList() ?? [];
            foreach (var param in Walk.Entries(definition.Definition, "params"))
            {
                if (param is null)
                {
                    continue;
                }
                var name = param.Text("name");
                var required = param.Value("required") as bool? ?? false;
                if (required && !supplied.Contains(name, StringComparer.Ordinal) && !param.Present("default"))
                {
                    found.Add(Diagnostic.Error("E208", file, document.At(entry.Pointer + "/meta").Value,
                        string.Create(CultureInfo.InvariantCulture,
                            $"Meta step {used} requires the parameter {name}, and this use site does not pass it.")));
                }
            }
            foreach (var name in supplied)
            {
                if (declared.Contains(name, StringComparer.Ordinal))
                {
                    continue;
                }
                found.Add(Diagnostic.Error("E208", file,
                        document.At(entry.Pointer + "/with/" + SuiteDocument.Escape(name)).Key,
                        string.Create(CultureInfo.InvariantCulture,
                            $"Meta step {used} declares no parameter {name}."))
                    .Suggest(Spelling.Nearest(name, declared, 2)));
            }
        }
        foreach (var name in names)
        {
            var (depth, cycle) = MetaDepth(name, definitions, []);
            var pointer = definitions[name].Pointer;
            if (cycle is not null)
            {
                found.Add(Diagnostic.Error("E207", file, document.At(pointer).Key,
                    string.Create(CultureInfo.InvariantCulture,
                        $"Meta step {name} is part of a cycle: {string.Join(" uses ", cycle)}.")));
            }
            else if (depth > 5)
            {
                found.Add(Diagnostic.Error("E207", file, document.At(pointer).Key,
                    string.Create(CultureInfo.InvariantCulture,
                        $"Meta step {name} nests {depth} deep, and five is the limit.")));
            }
        }

        // E209: a local declaration that silently shadows an imported one.
        foreach (var collision in library.Collisions)
        {
            found.Add(Diagnostic.Error("E209", file, document.At(collision.Pointer).Key,
                    string.Create(CultureInfo.InvariantCulture,
                        $"{collision.Kind} {collision.Name} is already declared by the imported {collision.Source}."))
                .Suggest("Add override: true to say that the replacement is deliberate."));
        }
        found.AddRange(library.Diagnostics);

        // E210: a parameter with no value anywhere, and a --param nobody
        // declared.
        var declaredParams = new Dictionary<string, ParamDeclaration>(StringComparer.Ordinal);
        foreach (var (name, declaration) in library.Params)
        {
            declaredParams[name] = new ParamDeclaration
            {
                HasValue = declaration.HasValue,
                Pointer = declaration.Pointer,
            };
        }
        var suiteParams = Walk.Entries(suite, "params");
        for (var index = 0; index < suiteParams.Count; index++)
        {
            var param = suiteParams[index];
            if (param is null)
            {
                continue;
            }
            declaredParams[param.Text("name")] = new ParamDeclaration
            {
                HasValue = param.Present("default") || param.Present("value") || param.Present("input"),
                Pointer = string.Create(CultureInfo.InvariantCulture, $"/params/{index}"),
            };
        }
        for (var caseIndex = 0; caseIndex < cases.Count; caseIndex++)
        {
            var held = cases[caseIndex];
            if (held is null)
            {
                continue;
            }
            var caseParams = Walk.Entries(held, "params");
            for (var paramIndex = 0; paramIndex < caseParams.Count; paramIndex++)
            {
                var param = caseParams[paramIndex];
                if (param is null)
                {
                    continue;
                }
                var name = param.Text("name");
                if (!declaredParams.TryGetValue(name, out var existing))
                {
                    existing = new ParamDeclaration
                    {
                        Pointer = string.Create(CultureInfo.InvariantCulture,
                            $"/tests/{caseIndex}/params/{paramIndex}"),
                    };
                }
                if (param.Present("value") || param.Present("default") || param.Present("input"))
                {
                    existing.HasValue = true;
                }
                declaredParams[name] = existing;
            }
        }
        var given = commandLineParams.Select(pair => pair.Key).ToHashSet(StringComparer.Ordinal);
        var declaredNames = declaredParams.Keys.ToList();
        declaredNames.Sort(StringComparer.Ordinal);
        foreach (var name in declaredNames)
        {
            var declaration = declaredParams[name];
            if (declaration.HasValue || given.Contains(name))
            {
                continue;
            }
            if (Environment.GetEnvironmentVariable(envPrefix + "PARAM_" + name.ToUpperInvariant()) is not null)
            {
                continue;
            }
            found.Add(Diagnostic.Error("E210", file, document.At(declaration.Pointer).Key,
                    string.Create(CultureInfo.InvariantCulture,
                        $"Parameter {name} has no value at any level and no default."))
                .Suggest(string.Create(CultureInfo.InvariantCulture,
                    $"Give it a default, or pass --param {name}=<value>.")));
        }
        foreach (var pair in commandLineParams)
        {
            if (declaredParams.ContainsKey(pair.Key))
            {
                continue;
            }
            found.Add(Diagnostic.Error("E210", file, document.At(string.Empty).Key,
                    string.Create(CultureInfo.InvariantCulture,
                        $"--param {pair.Key} names a parameter this suite does not declare."))
                .Suggest(Spelling.Nearest(pair.Key, declaredNames, 2)));
        }

        // E201 and W302: the action exists for the binding that was asked for,
        // and is not one the catalog has retired.
        foreach (var entry in Walk.AllSteps(suite))
        {
            var action = entry.Step.Text("action");
            if (!schema.Actions.TryGetValue(action, out var declaration))
            {
                continue;
            }
            var position = document.At(entry.Pointer + "/action").Value;
            if (declaration.Deprecated)
            {
                found.Add(Diagnostic.Warning("W302", file, position,
                    string.Create(CultureInfo.InvariantCulture,
                        $"Action {action} is marked deprecated in the catalog.")));
            }
            if (bindingCheck && !declaration.Bindings.Contains(binding, StringComparer.Ordinal))
            {
                found.Add(Diagnostic.Error("E201", file, position, string.Create(CultureInfo.InvariantCulture,
                    $"The {binding} binding does not implement {action}. Implemented by: {string.Join(", ", declaration.Bindings)}.")));
            }
        }

        return found;
    }
}
