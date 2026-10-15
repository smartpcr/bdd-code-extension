using System.Globalization;
using Bdd.Suite.Expressions;
using Bdd.Suite.Model;
using Bdd.Suite.Values;
using Bdd.Suite.Walking;

namespace Bdd.Suite.Execution;

/// <summary>Why a suite could not be expanded at all. Nothing has run when this
/// is thrown.</summary>
public sealed class ExpansionException(string message) : Exception(message);

/// <summary>What a suite's libraries contribute, in the order they were
/// imported.</summary>
public sealed class RunLibrary
{
    public List<OrderedMap> Params { get; } = [];
    public OrderedMap Vars { get; } = new();
    public Dictionary<string, OrderedMap> MetaSteps { get; } = new(StringComparer.Ordinal);
    public OrderedMap Defaults { get; } = new();
}

/// <summary>
/// One suite file as the runner executes it: meta steps expanded, tables and
/// outlines turned into one step per row, parameters resolved, and every step
/// carrying a label a report and a trace can print.
///
/// Everything here happens before the first action runs. A file that expands
/// cleanly is a file whose shape the run no longer has to think about.
/// </summary>
public static class SuiteExpansion
{
    /// <summary>How deep a meta step may use another before it is a cycle rather
    /// than a nest, which is refused here rather than left to recurse.</summary>
    private const int MetaDepthLimit = 5;

    private static readonly string[] GherkinKeywords = ["given", "when", "then", "and"];

    /// <summary>
    /// Read the libraries a suite imports, depth first and in order.
    ///
    /// What a library imports is in scope before the library's own declarations,
    /// so the nearer file wins. A cycle is refused rather than recursed into.
    /// </summary>
    public static RunLibrary ReadLibraries(OrderedMap suite, string filePath)
    {
        var library = new RunLibrary();
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { Path.GetFullPath(filePath) };
        WalkImports(suite, filePath, visited, library);
        return library;
    }

    private static void WalkImports(
        OrderedMap suite, string filePath, HashSet<string> visited, RunLibrary library)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(filePath)) ?? ".";
        foreach (var raw in suite.List("imports") ?? [])
        {
            if (raw is not string name || name.Length == 0)
            {
                continue;
            }
            var path = Path.Combine(directory, name);
            var full = Path.GetFullPath(path);
            if (visited.Contains(full))
            {
                throw new ExpansionException(string.Create(CultureInfo.InvariantCulture,
                    $"Import {name} forms a cycle."));
            }
            if (!File.Exists(path))
            {
                throw new ExpansionException(string.Create(CultureInfo.InvariantCulture,
                    $"Import {name} does not exist at {path}."));
            }
            visited.Add(full);
            OrderedMap imported;
            try
            {
                imported = SuiteDocument.Load(File.ReadAllText(path)).Value as OrderedMap
                    ?? throw new ExpansionException(string.Create(CultureInfo.InvariantCulture,
                        $"Import {name} does not hold a YAML mapping."));
            }
            catch (LoadException failure)
            {
                throw new ExpansionException(string.Create(CultureInfo.InvariantCulture,
                    $"Import {name} is not valid YAML: {failure.Message}"));
            }
            WalkImports(imported, path, visited, library);
            foreach (var param in Walk.Entries(imported, "params"))
            {
                if (param is not null)
                {
                    library.Params.Add(param);
                }
            }
            foreach (var key in imported.Map("vars")?.Keys ?? [])
            {
                library.Vars.Set(key, imported.Map("vars")!.Value(key));
            }
            foreach (var meta in Walk.Entries(imported, "metaSteps"))
            {
                if (meta is not null)
                {
                    library.MetaSteps[meta.Text("name")] = meta;
                }
            }
            foreach (var key in imported.Map("defaults")?.Keys ?? [])
            {
                library.Defaults.Set(key, imported.Map("defaults")!.Value(key));
            }
        }
    }

    /// <summary>Every meta step in scope, indexed by name. A local declaration
    /// wins.</summary>
    public static Dictionary<string, OrderedMap> MetaDefinitions(OrderedMap suite, RunLibrary library)
    {
        var definitions = new Dictionary<string, OrderedMap>(library.MetaSteps, StringComparer.Ordinal);
        foreach (var meta in Walk.Entries(suite, "metaSteps"))
        {
            if (meta is not null)
            {
                definitions[meta.Text("name")] = meta;
            }
        }
        return definitions;
    }

    /// <summary>Substitute ${param.x} inside a meta step's body, leaving a name
    /// the use site has no value for alone: the dataflow pass is what reports it,
    /// with a position.</summary>
    private static object? BindMetaParams(object? value, OrderedMap arguments)
    {
        switch (value)
        {
            case string text:
            {
                var out_ = text;
                foreach (var name in arguments.Keys)
                {
                    out_ = out_.Replace("${param." + name + "}", Value.Text(arguments.Value(name)),
                        StringComparison.Ordinal);
                }
                return out_;
            }
            case List<object?> items:
                return items.Select(item => BindMetaParams(item, arguments)).ToList();
            case OrderedMap map:
            {
                var out_ = new OrderedMap();
                foreach (var key in map.Keys)
                {
                    out_.Set(key, BindMetaParams(map.Value(key), arguments));
                }
                return out_;
            }
            default:
                return value;
        }
    }

    /// <summary>One row as the text a report entry carries: column=value, in
    /// order.</summary>
    public static string FormatRow(object? row) =>
        row is not OrderedMap held
            ? string.Empty
            : string.Join(", ", held.Keys.Select(column => column + "=" + Value.Text(held.Value(column))));

    /// <summary>
    /// What the trace and a failure call one step.
    ///
    /// The sentence first when the step has one, because that is what says what
    /// the step means; the action in brackets, because that is what ran; the row
    /// last, because the sentence says what the step means and the row says which
    /// of them this is.
    /// </summary>
    public static string StepLabel(OrderedMap step)
    {
        var action = step.Text("action");
        var row = step.Value("__rowIndex") is long index
            ? string.Create(CultureInfo.InvariantCulture, $" row {index} ({FormatRow(step.Value("__row"))})")
            : string.Empty;
        var keyword = step.Text("__keyword");
        var sentence = step.Text("__sentence");
        if (keyword.Length > 0 && sentence.Length > 0)
        {
            return string.Create(CultureInfo.InvariantCulture, $"{keyword} {sentence} ({action}){row}");
        }
        var provenance = step.Text("__provenance");
        if (provenance.Length > 0)
        {
            return string.Create(CultureInfo.InvariantCulture, $"{provenance} ({action}){row}");
        }
        return string.Create(CultureInfo.InvariantCulture, $"step {action}{row}");
    }

    /// <summary>
    /// Lift a step's Gherkin keyword and sentence onto it, so nothing after this
    /// has to know which of the four keys carried it.
    ///
    /// DEC-Y22: an `and` becomes the keyword it continues, once, here. The
    /// sentence stays the step's own; only the keyword is inherited, because a
    /// report that said `and` on its own would not say whether the step
    /// establishes something, exercises it or observes it.
    /// </summary>
    private static void ResolveKeyword(OrderedMap step, ref string previous)
    {
        foreach (var keyword in new[] { "given", "when", "then" })
        {
            if (step.Text(keyword).Length > 0)
            {
                previous = keyword;
            }
        }
        var continued = step.Text("and");
        if (continued.Length > 0)
        {
            step.Set("__keyword", previous.Length > 0 ? previous : "and");
            step.Set("__sentence", continued);
            return;
        }
        foreach (var keyword in GherkinKeywords)
        {
            var sentence = step.Text(keyword);
            if (sentence.Length > 0)
            {
                step.Set("__keyword", keyword);
                step.Set("__sentence", sentence);
                return;
            }
        }
    }

    /// <summary>One step list, with every meta use site replaced by the steps it
    /// stands for and every table replaced by one step per row.</summary>
    public static List<OrderedMap> ExpandSteps(
        List<object?>? steps, Dictionary<string, OrderedMap> definitions,
        string whereItIs, int depth, string provenance)
    {
        var expanded = new List<OrderedMap>();
        // The keyword an `and` continues, tracked across this list only: a case's
        // steps are one scenario and its cleanup is not part of it.
        var previous = string.Empty;
        for (var index = 0; index < (steps?.Count ?? 0); index++)
        {
            if (steps![index] is not OrderedMap step)
            {
                continue;
            }
            var position = provenance.Length == 0
                ? string.Create(CultureInfo.InvariantCulture, $"step {index + 1}")
                : string.Create(CultureInfo.InvariantCulture, $"{provenance} step {index + 1}");

            var used = step.Text("meta");
            if (used.Length > 0)
            {
                if (!definitions.TryGetValue(used, out var definition))
                {
                    throw new ExpansionException(string.Create(CultureInfo.InvariantCulture,
                        $"{whereItIs} {position} uses meta step {used}, which is not declared or imported."));
                }
                if (depth >= MetaDepthLimit)
                {
                    throw new ExpansionException(string.Create(CultureInfo.InvariantCulture,
                        $"{whereItIs} {position} nests meta steps deeper than {MetaDepthLimit}, which is the limit. A meta step that uses itself, directly or through another, is a cycle."));
                }
                var arguments = new OrderedMap();
                foreach (var declared in Walk.Entries(definition, "params"))
                {
                    if (declared is not null && declared.Present("default"))
                    {
                        arguments.Set(declared.Text("name"), declared.Value("default"));
                    }
                }
                if (step.Map("with") is { } with)
                {
                    foreach (var key in with.Keys)
                    {
                        arguments.Set(key, with.Value(key));
                    }
                }
                var body = (definition.List("steps") ?? [])
                    .Select(inner => BindMetaParams(inner, arguments)).ToList();
                var guard = step.Text("ifCapture");
                foreach (var inner in ExpandSteps(body, definitions, whereItIs, depth + 1, "meta " + used))
                {
                    // A nested step that carries a guard from the use site
                    // inherits it, so `- meta: x` with ifCapture skips the whole
                    // group.
                    if (guard.Length > 0 && inner.Text("ifCapture").Length == 0)
                    {
                        inner.Set("ifCapture", guard);
                    }
                    expanded.Add(inner);
                }
                continue;
            }

            if (step.Value("table") is List<object?> rows)
            {
                for (var rowIndex = 0; rowIndex < rows.Count; rowIndex++)
                {
                    var copied = step.Clone();
                    copied.Remove("table");
                    copied.Set("__row", rows[rowIndex]);
                    copied.Set("__rowIndex", (long)(rowIndex + 1));
                    copied.Set("__rowCount", (long)rows.Count);
                    copied.Set("__provenance", position);
                    ResolveKeyword(copied, ref previous);
                    expanded.Add(copied);
                }
                continue;
            }

            var plain = step.Clone();
            plain.Set("__provenance", position);
            ResolveKeyword(plain, ref previous);
            expanded.Add(plain);
        }
        return expanded;
    }

    /// <summary>One case per row of its examples block, named by the row.</summary>
    public static List<OrderedMap> ExpandOutline(OrderedMap held)
    {
        if (held.Value("examples") is not List<object?> rows || rows.Count == 0)
        {
            return [held];
        }
        var name = held.Text("name");
        var out_ = new List<OrderedMap>(rows.Count);
        foreach (var row in rows)
        {
            var copied = held.Clone();
            copied.Remove("examples");
            copied.Set("name", string.Create(CultureInfo.InvariantCulture, $"{name} [{FormatRow(row)}]"));
            copied.Set("__row", row);
            out_.Add(copied);
        }
        return out_;
    }

    /// <summary>
    /// The value each declared parameter takes, highest source first.
    ///
    /// DEC-Y18, in this order: the command line, the environment, the case, the
    /// file, the library. Every level is checked so that the answer is the same
    /// whichever level happens to hold a value. The environment variable is
    /// &lt;prefix&gt;PARAM_&lt;NAME&gt;, BDD_SUITE_PARAM_&lt;NAME&gt; unless an
    /// extension sets another prefix.
    /// </summary>
    public static OrderedMap ResolveParams(
        RunLibrary library, OrderedMap suite, OrderedMap? held,
        IReadOnlyList<KeyValuePair<string, string>> commandLine,
        string envPrefix = Extensions.Composite.DefaultEnvPrefix)
    {
        var values = new OrderedMap();
        var declarations = new List<OrderedMap>(library.Params);
        declarations.AddRange(Walk.Entries(suite, "params").Where(param => param is not null).Select(param => param!));
        var fileLevel = declarations.Count;
        if (held is not null)
        {
            declarations.AddRange(Walk.Entries(held, "params").Where(param => param is not null).Select(param => param!));
        }
        foreach (var declared in declarations)
        {
            var name = declared.Text("name");
            if (name.Length == 0)
            {
                continue;
            }
            if (declared.Present("default"))
            {
                values.Set(name, declared.Value("default"));
            }
            if (declared.Present("value"))
            {
                values.Set(name, declared.Value("value"));
            }
        }
        var names = values.Keys.ToList();
        foreach (var declared in declarations.Take(fileLevel))
        {
            var name = declared.Text("name");
            if (name.Length > 0 && !names.Contains(name, StringComparer.Ordinal))
            {
                names.Add(name);
            }
        }
        foreach (var name in names)
        {
            if (Environment.GetEnvironmentVariable(envPrefix + "PARAM_" + name.ToUpperInvariant()) is { } found)
            {
                values.Set(name, found);
            }
        }
        foreach (var pair in commandLine)
        {
            values.Set(pair.Key, pair.Value);
        }
        return values;
    }

    /// <summary>The variables a case sees: the library's, the suite's, then its
    /// own, each evaluated once against everything already in scope.</summary>
    public static void ResolveVars(
        RunLibrary library, OrderedMap suite, OrderedMap? held, OrderedMap scope,
        IReadOnlyList<string>? roots = null)
    {
        roots ??= Expression.CoreRoots;
        var sources = new List<OrderedMap> { library.Vars };
        if (suite.Map("vars") is { } suiteVars)
        {
            sources.Add(suiteVars);
        }
        if (held?.Map("vars") is { } caseVars)
        {
            sources.Add(caseVars);
        }
        if (scope.Map("var") is not { } bag)
        {
            bag = new OrderedMap();
            scope.Set("var", bag);
        }
        foreach (var source in sources)
        {
            foreach (var name in source.Keys)
            {
                bag.Set(name, Expression.Expand(source.Value(name), Scope.Against(scope, roots)));
            }
        }
    }

    /// <summary>Whether a case is selected by a tag filter.</summary>
    public static bool TagsMatch(IReadOnlyList<string> caseTags, IReadOnlyList<string> filter) =>
        filter.Count == 0 || caseTags.Any(tag => filter.Contains(tag, StringComparer.Ordinal));

    /// <summary>Every tag that applies to a case: its own and the suite's.</summary>
    public static List<string> CaseTags(OrderedMap suite, OrderedMap held)
    {
        var tags = new List<string>();
        foreach (var source in new[] { held, suite })
        {
            foreach (var raw in source.List("tags") ?? [])
            {
                if (raw is string tag)
                {
                    tags.Add(tag);
                }
            }
        }
        return tags;
    }

    /// <summary>Every step list of one case, expanded, in the order the phases
    /// run.</summary>
    public static Dictionary<string, List<OrderedMap>> ExpandedCase(
        OrderedMap held, Dictionary<string, OrderedMap> definitions)
    {
        var phases = new Dictionary<string, List<OrderedMap>>(StringComparer.Ordinal);
        foreach (var phase in Walk.CasePhases)
        {
            phases[phase] = ExpandSteps(held.List(phase), definitions, "case " + held.Text("name"), 0, string.Empty);
        }
        return phases;
    }

    /// <summary>The suite's own hook lists, expanded.</summary>
    public static Dictionary<string, List<OrderedMap>> ExpandedHooks(
        OrderedMap suite, Dictionary<string, OrderedMap> definitions)
    {
        var hooks = new Dictionary<string, List<OrderedMap>>(StringComparer.Ordinal);
        foreach (var hook in Walk.Hooks)
        {
            hooks[hook] = ExpandSteps(suite.List(hook), definitions, "the suite " + hook, 0, string.Empty);
        }
        return hooks;
    }

    /// <summary>Every case a file runs, outlines expanded.</summary>
    public static List<OrderedMap> Cases(OrderedMap suite)
    {
        var found = new List<OrderedMap>();
        foreach (var held in Walk.Entries(suite, "tests"))
        {
            if (held is not null)
            {
                found.AddRange(ExpandOutline(held));
            }
        }
        return found;
    }


    /// <summary>
    /// One step's own limit, or what remains of the case, whichever is smaller.
    ///
    /// The innermost number wins and never raises: a step may shorten its share
    /// of the case's budget and may never lengthen it (DEC-Y08).
    /// </summary>
    public static long StepLimit(long ownSec, long remainingSec) =>
        ownSec > 0 ? Math.Min(ownSec, remainingSec) : remainingSec;
}
