using System.Globalization;
using Bdd.Suite.Assertions;
using Bdd.Suite.Diagnostics;
using Bdd.Suite.Expressions;
using Bdd.Suite.Model;
using Bdd.Suite.Schema;
using Bdd.Suite.Text;
using Bdd.Suite.Walking;

namespace Bdd.Suite.Validation;

/// <summary>
/// E301 to E309, W301 and W303: every reference resolves, every path into a
/// capture is one the action declares, and nothing is captured for nobody.
///
/// This pass needs the case expanded - the suite setup, the hooks and the case's
/// own phases in the order they run - because whether a capture exists yet
/// depends on when the step that produces it runs.
/// </summary>
public static class Dataflow
{
    /// <summary>The bare names a path may start at that are not a bag of their
    /// own, before any extension adds a context key.</summary>
    private static readonly string[] CoreContextKeys = ["timeoutSec", "defaults"];

    /// <summary>Where a capture comes from, and when.</summary>
    private sealed class Produced
    {
        public long Order { get; init; }
        public string Action { get; init; } = string.Empty;
        public string Pointer { get; init; } = string.Empty;

        /// <summary>Set when the step carries a table: it runs once per row and
        /// publishes a list, so a path into that capture starts with an index
        /// (DEC-Y23).</summary>
        public bool List { get; set; }
    }

    /// <summary>One value to look for references in, and what is in scope where
    /// it is.</summary>
    private sealed class ReferenceSite
    {
        public object? Value { get; init; }
        public string Pointer { get; init; } = string.Empty;
        public long Order { get; init; }
        public bool InMeta { get; init; }
        public List<string> Columns { get; init; } = [];
    }

    /// <summary>What a walk into a declared capture shape found.</summary>
    private readonly record struct ShapeResult(bool Ok, string Expected, List<string> Candidates);

    /// <summary>One case as the ordered phases the runner executes it in.</summary>
    private static List<StepEntry> CasePlan(OrderedMap suite, OrderedMap held, int caseIndex)
    {
        var plan = new List<StepEntry>();
        void Add(OrderedMap? owner, string key, string pointer, string phase, long baseOrder)
        {
            foreach (var entry in Walk.StepEntries(owner?.List(key), pointer, phase))
            {
                entry.Order += baseOrder;
                plan.Add(entry);
            }
        }
        Add(suite, "setup", "/setup", "suite setup", -4000);
        Add(suite, "beforeEach", "/beforeEach", "beforeEach", -3000);
        Add(held, "setup", string.Create(CultureInfo.InvariantCulture, $"/tests/{caseIndex}/setup"), "case setup", -2000);
        Add(held, "steps", string.Create(CultureInfo.InvariantCulture, $"/tests/{caseIndex}/steps"), "steps", 0);
        Add(held, "cleanup", string.Create(CultureInfo.InvariantCulture, $"/tests/{caseIndex}/cleanup"), "cleanup", 100000);
        Add(suite, "afterEach", "/afterEach", "afterEach", 200000);
        // The suite teardown is deliberately absent: it runs once, after the last
        // case, and reads the suite bag rather than any case copy (design 5.3).
        return plan;
    }

    /// <summary>
    /// E302: a dotted path has to exist in the shape its action declares.
    ///
    /// The walk stops as soon as the shape is open or untyped, which is the
    /// honest answer for an API response: the path may well be there, and the
    /// catalog is not the place that knows.
    /// </summary>
    private static ShapeResult WalkShape(object? shape, IReadOnlyList<string> segments)
    {
        var open = new ShapeResult(true, string.Empty, []);
        var current = shape;
        foreach (var segment in segments)
        {
            if (current is not OrderedMap node)
            {
                return open;
            }
            var kind = node.Text("type");
            if (kind.Length == 0 || string.Equals(kind, "any", StringComparison.Ordinal))
            {
                return open;
            }
            if (string.Equals(kind, "array", StringComparison.Ordinal))
            {
                if (!int.TryParse(segment, NumberStyles.Integer, CultureInfo.InvariantCulture, out _)
                    && !string.Equals(segment, "<index>", StringComparison.Ordinal))
                {
                    return new ShapeResult(false, "an index into an array", []);
                }
                current = node.Value("items");
                continue;
            }
            if (!string.Equals(kind, "object", StringComparison.Ordinal))
            {
                return new ShapeResult(false, string.Create(CultureInfo.InvariantCulture,
                    $"a {kind}, which has no {segment} inside it"), []);
            }
            // Truthy, not merely present. "additionalProperties: false" is the
            // catalog saying the shape is closed, and reading it as "there is
            // something here" would stop the walk at every closed object.
            if (node.Value("additionalProperties") is true)
            {
                return open;
            }
            var properties = node.Map("properties");
            var declared = properties?.Keys.ToList() ?? [];
            if (!declared.Contains(segment, StringComparer.Ordinal))
            {
                return new ShapeResult(false, "not declared", declared);
            }
            current = properties?.Value(segment);
        }
        return open;
    }

    /// <summary>E301, E302 and the read that W301 counts, for one dotted
    /// subject.</summary>
    private static List<Diagnostic> Subject(
        string text, string pointer, SuiteDocument document, string file, SuiteSchema schema,
        Dictionary<string, Produced> sources, string caseName, HashSet<string> read, bool atKey)
    {
        var found = new List<Diagnostic>();
        var segments = text.Split('.');
        var name = segments[0];
        read.Add(name);
        var node = document.At(pointer);
        var position = atKey ? node.Key : node.Value;
        if (!sources.TryGetValue(name, out var source))
        {
            found.Add(Diagnostic.Error("E301", file, position, string.Create(CultureInfo.InvariantCulture,
                    $"No step in case {caseName} captures {name}."))
                .Suggest(Spelling.Nearest(name, SortedNames(sources), 2)));
            return found;
        }
        if (!schema.Actions.TryGetValue(source.Action, out var declared))
        {
            return found;
        }
        var shape = declared.Captures;
        if (source.List)
        {
            var wrapped = new OrderedMap();
            wrapped.Set("type", "array");
            wrapped.Set("items", shape);
            shape = wrapped;
        }
        if (segments.Length <= 1)
        {
            return found;
        }
        var result = WalkShape(shape, segments[1..]);
        if (result.Ok)
        {
            return found;
        }
        var finding = Diagnostic.Error("E302", file, position, string.Create(CultureInfo.InvariantCulture,
            $"Action {source.Action} does not declare {text} in what it captures."));
        if (result.Candidates.Count == 0)
        {
            // Nothing to suggest, so the shape says what it wanted instead.
            finding = finding.Suggest("That path wants " + result.Expected + ".");
        }
        else
        {
            var nearest = Spelling.Nearest(segments[^1], result.Candidates, 2);
            finding = finding.Suggest(nearest.Length > 0
                ? "Did you mean " + nearest
                : "Declared: " + string.Join(", ", result.Candidates));
        }
        found.Add(finding);
        return found;
    }

    /// <summary>E308: a pattern outside the subset the four engines
    /// share.</summary>
    private static List<Diagnostic> PortablePattern(
        string pattern, string pointer, SuiteDocument document, string file)
    {
        var construct = Comparer.Unportable(pattern);
        if (construct.Length == 0)
        {
            return [];
        }
        return
        [
            Diagnostic.Error("E308", file, document.At(pointer).Value,
                    string.Create(CultureInfo.InvariantCulture,
                        $"The pattern uses {construct}, which the Go binding's RE2 engine cannot run."))
                .Suggest("Restrict the pattern to the subset RE2 and .NET agree on."),
        ];
    }

    private static List<string> SortedNames(Dictionary<string, Produced> sources)
    {
        var names = sources.Keys.ToList();
        names.Sort(StringComparer.Ordinal);
        return names;
    }

    private static List<string> SortedSet(HashSet<string> held)
    {
        var names = held.ToList();
        names.Sort(StringComparer.Ordinal);
        return names;
    }

    /// <summary>The dataflow pass.</summary>
    /// <param name="contextKeys">The context keys the runtime's extensions
    /// declare; each is a bare name a path may start at, like timeoutSec.</param>
    public static List<Diagnostic> Check(
        SuiteDocument document, string file, SuiteSchema schema, Library library,
        IReadOnlyList<string>? contextKeys = null)
    {
        List<string> contextNames = [.. CoreContextKeys, .. contextKeys ?? []];
        var found = new List<Diagnostic>();
        if (document.Value is not OrderedMap suite)
        {
            return found;
        }

        var declaredParams = new HashSet<string>(library.Params.Keys, StringComparer.Ordinal);
        foreach (var param in Walk.Entries(suite, "params"))
        {
            if (param is not null)
            {
                declaredParams.Add(param.Text("name"));
            }
        }
        var suiteVars = new HashSet<string>(library.Vars.Keys, StringComparer.Ordinal);
        foreach (var name in suite.Map("vars")?.Keys ?? [])
        {
            suiteVars.Add(name);
        }
        var readParams = new HashSet<string>(StringComparer.Ordinal);

        // Every capture name the file produces anywhere. A bare name that is one
        // of these is a reference written without its root, and the message can
        // say both halves of it.
        var fileCaptures = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in Walk.AllSteps(suite))
        {
            var name = entry.Step.Text("captureAs");
            if (name.Length > 0)
            {
                fileCaptures.Add(name);
            }
        }

        var cases = Walk.Entries(suite, "tests");
        for (var caseIndex = 0; caseIndex < cases.Count; caseIndex++)
        {
            var held = cases[caseIndex];
            if (held is null)
            {
                continue;
            }
            var caseName = held.Text("name");
            var plan = CasePlan(suite, held, caseIndex);
            var caseVars = new HashSet<string>(suiteVars, StringComparer.Ordinal);
            foreach (var name in held.Map("vars")?.Keys ?? [])
            {
                caseVars.Add(name);
            }
            foreach (var param in Walk.Entries(held, "params"))
            {
                if (param is not null)
                {
                    declaredParams.Add(param.Text("name"));
                }
            }

            var sources = new Dictionary<string, Produced>(StringComparer.Ordinal);
            foreach (var entry in plan)
            {
                var name = entry.Step.Text("captureAs");
                if (name.Length == 0)
                {
                    continue;
                }
                if (sources.TryGetValue(name, out var existing) && entry.Order >= existing.Order)
                {
                    continue;
                }
                sources[name] = new Produced
                {
                    Order = entry.Order,
                    Action = entry.Step.Text("action"),
                    Pointer = entry.Pointer,
                    List = entry.Step.Present("table"),
                };
            }

            // A meta use site publishes what its definition exports, under the
            // names the definition gave them. The action is left blank because
            // the export's shape belongs to whichever step inside produced it,
            // and a use site cannot rename it (DEC-Y10).
            foreach (var entry in plan)
            {
                var used = entry.Step.Text("meta");
                if (used.Length == 0)
                {
                    continue;
                }
                var definition = Walk.Entries(suite, "metaSteps")
                    .FirstOrDefault(meta => meta is not null
                        && string.Equals(meta.Text("name"), used, StringComparison.Ordinal));
                if (definition is null)
                {
                    library.MetaSteps.TryGetValue(used, out definition);
                }
                if (definition is null)
                {
                    continue;
                }
                foreach (var raw in definition.List("exports") ?? [])
                {
                    if (raw is not string name || name.Length == 0)
                    {
                        continue;
                    }
                    sources[name] = new Produced { Order = entry.Order, Pointer = entry.Pointer };
                }
            }

            var caseColumns = Walk.TableColumns(held.Value("examples"));
            var read = new HashSet<string>(StringComparer.Ordinal);
            var checks = new List<ReferenceSite>();
            foreach (var entry in plan)
            {
                var columns = new List<string>(caseColumns);
                columns.AddRange(Walk.TableColumns(entry.Step.Value("table")));
                checks.Add(new ReferenceSite
                {
                    Value = entry.Step,
                    Pointer = entry.Pointer,
                    Order = entry.Order,
                    InMeta = entry.Phase.StartsWith("meta ", StringComparison.Ordinal),
                    Columns = columns,
                });
                var guard = entry.Step.Text("ifCapture");
                if (!sources.ContainsKey(guard)) guard = guard.Split('.')[0];
                if (guard.Length == 0)
                {
                    continue;
                }
                // A guard may name a capture that is not there yet: that is the
                // whole point of it. So this is an existence check and never an
                // ordering one. A name no step in the case declares at all is a
                // typo, and a typo here silently disables a cleanup step.
                read.Add(guard);
                if (!sources.ContainsKey(guard))
                {
                    found.Add(Diagnostic.Error("E301", file,
                            document.At(entry.Pointer + "/ifCapture").Value,
                            string.Create(CultureInfo.InvariantCulture,
                                $"ifCapture names {guard}, which no step in case {caseName} captures."))
                        .Suggest(Spelling.Nearest(guard, SortedNames(sources), 2)));
                }
            }

            // A case's own assertions read anything the case produced; a step's
            // own assertions read anything up to and including that step.
            List<Diagnostic> AddAssertions(
                object? assertions, string pointer, long order,
                List<string> columns, Dictionary<string, Produced> visible)
            {
                var here = new List<Diagnostic>();
                if (assertions is not List<object?> list)
                {
                    return here;
                }
                for (var index = 0; index < list.Count; index++)
                {
                    if (list[index] is not OrderedMap one)
                    {
                        continue;
                    }
                    checks.Add(new ReferenceSite
                    {
                        Value = one,
                        Pointer = string.Create(CultureInfo.InvariantCulture, $"{pointer}/{index}"),
                        Order = order,
                        Columns = columns,
                    });
                    var variable = one.Text("var");
                    if (variable.Length > 0)
                    {
                        here.AddRange(Subject(variable,
                            string.Create(CultureInfo.InvariantCulture, $"{pointer}/{index}/var"),
                            document, file, schema, visible, caseName, read, false));
                    }
                    var pattern = one.Text("matches");
                    if (pattern.Length > 0)
                    {
                        here.AddRange(PortablePattern(pattern,
                            string.Create(CultureInfo.InvariantCulture, $"{pointer}/{index}/matches"),
                            document, file));
                    }
                    // A script assertion reads the bag directly, so what it names
                    // is read even though it is not a ${...} reference.
                    var script = one.Text("script");
                    var pieces = script.Split("capture.");
                    for (var piece = 1; piece < pieces.Length; piece++)
                    {
                        var name = LeadingName(pieces[piece]);
                        if (name.Length > 0)
                        {
                            read.Add(name);
                        }
                    }
                }
                return here;
            }

            found.AddRange(AddAssertions(held.Value("asserts"),
                string.Create(CultureInfo.InvariantCulture, $"/tests/{caseIndex}/asserts"),
                99999, caseColumns, sources));
            foreach (var entry in plan)
            {
                if (!entry.Step.Present("asserts"))
                {
                    continue;
                }
                // Inside a table step's own assertions the capture is that row's
                // result, not the list the step publishes afterwards.
                var visible = new Dictionary<string, Produced>(sources, StringComparer.Ordinal);
                var own = entry.Step.Text("captureAs");
                if (entry.Step.Present("table") && own.Length > 0 && visible.TryGetValue(own, out var source))
                {
                    visible[own] = new Produced
                    {
                        Order = source.Order,
                        Action = source.Action,
                        Pointer = source.Pointer,
                        List = false,
                    };
                }
                var columns = new List<string>(caseColumns);
                columns.AddRange(Walk.TableColumns(entry.Step.Value("table")));
                found.AddRange(AddAssertions(entry.Step.Value("asserts"),
                    entry.Pointer + "/asserts", entry.Order + 1, columns, visible));
            }

            foreach (var one in checks)
            {
                foreach (var reference in Expression.References(one.Value, one.Pointer))
                {
                    var position = document.At(reference.Pointer).Value;
                    var reading = Expression.Read(reference.Text, false);
                    if (reading.Error is { } refused)
                    {
                        var finding = Diagnostic.Error(refused.Code, file, position,
                            string.Create(CultureInfo.InvariantCulture,
                                $"${{{reference.Text}}} does not parse: {refused.Message}."));
                        if (string.Equals(refused.Code, "E306", StringComparison.Ordinal))
                        {
                            var at = refused.Message.IndexOf("Did you mean ", StringComparison.Ordinal);
                            if (at >= 0)
                            {
                                finding = finding.Suggest("Did you mean "
                                    + refused.Message[(at + "Did you mean ".Length)..].TrimEnd('?', '.'));
                            }
                        }
                        found.Add(finding);
                        continue;
                    }
                    foreach (var segments in reading.Paths)
                    {
                        var whole = string.Join('.', segments);
                        switch (segments[0])
                        {
                            case "capture":
                            {
                                if (segments.Count < 2)
                                {
                                    found.Add(Diagnostic.Error("E301", file, position,
                                        "A capture reference needs a name: ${capture.<name>}."));
                                    continue;
                                }
                                var name = segments[1];
                                read.Add(name);
                                if (!sources.TryGetValue(name, out var source))
                                {
                                    found.Add(Diagnostic.Error("E301", file, position,
                                            string.Create(CultureInfo.InvariantCulture,
                                                $"No step in case {caseName} captures {name}."))
                                        .Suggest(Spelling.Nearest(name, SortedNames(sources), 2)));
                                    continue;
                                }
                                if (source.Order >= one.Order)
                                {
                                    found.Add(Diagnostic.Error("E303", file, position,
                                        string.Create(CultureInfo.InvariantCulture,
                                            $"Capture {name} is read before the step that produces it.")));
                                    continue;
                                }
                                found.AddRange(Subject(string.Join('.', segments[1..]), reference.Pointer,
                                    document, file, schema, sources, caseName, read, false));
                                break;
                            }
                            case "param":
                            {
                                if (segments.Count < 2)
                                {
                                    continue;
                                }
                                readParams.Add(segments[1]);
                                // A meta step's parameter is resolved at its use
                                // site.
                                if (one.InMeta)
                                {
                                    continue;
                                }
                                if (!declaredParams.Contains(segments[1]))
                                {
                                    found.Add(Diagnostic.Error("E301", file, position,
                                            string.Create(CultureInfo.InvariantCulture,
                                                $"No parameter named {segments[1]} is declared or imported."))
                                        .Suggest(Spelling.Nearest(segments[1], SortedSet(declaredParams), 2)));
                                }
                                break;
                            }
                            case "var":
                            {
                                if (segments.Count < 2)
                                {
                                    continue;
                                }
                                if (!caseVars.Contains(segments[1]))
                                {
                                    found.Add(Diagnostic.Error("E301", file, position,
                                            string.Create(CultureInfo.InvariantCulture,
                                                $"No variable named {segments[1]} is declared."))
                                        .Suggest(Spelling.Nearest(segments[1], SortedSet(caseVars), 2)));
                                }
                                break;
                            }
                            case "defaults":
                            {
                                if (segments.Count < 2)
                                {
                                    continue;
                                }
                                var declared = suite.Map("defaults")?.Keys ?? [];
                                if (!declared.Contains(segments[1], StringComparer.Ordinal))
                                {
                                    found.Add(Diagnostic.Error("E301", file, position,
                                        string.Create(CultureInfo.InvariantCulture,
                                            $"The defaults block declares no {segments[1]}.")));
                                }
                                break;
                            }
                            case "row":
                            {
                                if (one.Columns.Count == 0)
                                {
                                    found.Add(Diagnostic.Error("E301", file, position,
                                        "${row} has no table in scope. A row exists inside a step that carries a table, or a case that carries examples."));
                                    continue;
                                }
                                if (segments.Count < 2)
                                {
                                    found.Add(Diagnostic.Error("E301", file, position,
                                            "A row reference needs a column: ${row.<column>}.")
                                        .Suggest("Declared: " + string.Join(", ", one.Columns)));
                                    continue;
                                }
                                if (!one.Columns.Contains(segments[1], StringComparer.Ordinal))
                                {
                                    found.Add(Diagnostic.Error("E301", file, position,
                                            string.Create(CultureInfo.InvariantCulture,
                                                $"The table in scope declares no column {segments[1]}."))
                                        .Suggest(Spelling.Nearest(segments[1], one.Columns, 2)));
                                }
                                break;
                            }
                            default:
                            {
                                var root = segments[0];
                                if (contextNames.Contains(root, StringComparer.Ordinal) && segments.Count == 1)
                                {
                                    continue;
                                }
                                string suggestion;
                                if (sources.ContainsKey(root))
                                {
                                    suggestion = string.Create(CultureInfo.InvariantCulture,
                                        $"Captures are read as ${{capture.{whole}}}.");
                                }
                                else if (fileCaptures.Contains(root))
                                {
                                    suggestion = string.Create(CultureInfo.InvariantCulture,
                                        $"Captures are read as ${{capture.{whole}}}, and only in the case that captured {root}. Capture it in case {caseName} too.");
                                }
                                else
                                {
                                    var candidates = new List<string>(contextNames) { "capture", "param", "var" };
                                    var nearest = Spelling.Nearest(root, candidates, 2);
                                    suggestion = nearest.Length > 0 ? "Did you mean " + nearest : string.Empty;
                                }
                                found.Add(Diagnostic.Error("E301", file, position,
                                        string.Create(CultureInfo.InvariantCulture,
                                            $"${{{whole}}} resolves to nothing. A path starts at capture, param, var or a context key."))
                                    .Suggest(suggestion));
                                break;
                            }
                        }
                    }
                }
            }

            // W301: a capture nothing reads is a step whose result nobody
            // checked.
            foreach (var name in SortedNames(sources))
            {
                var source = sources[name];
                if (read.Contains(name))
                {
                    continue;
                }
                if (!source.Pointer.StartsWith(
                        string.Create(CultureInfo.InvariantCulture, $"/tests/{caseIndex}/"), StringComparison.Ordinal))
                {
                    continue;
                }
                found.Add(Diagnostic.Warning("W301", file,
                    document.At(source.Pointer + "/captureAs").Value,
                    string.Create(CultureInfo.InvariantCulture,
                        $"Capture {name} in case {caseName} is never read by a later step, an assertion or a cleanup.")));
            }
        }

        // E304: a meta step promising an export no step of it captures.
        var metas = Walk.Entries(suite, "metaSteps");
        for (var metaIndex = 0; metaIndex < metas.Count; metaIndex++)
        {
            var meta = metas[metaIndex];
            if (meta is null)
            {
                continue;
            }
            var captured = Walk.Entries(meta, "steps")
                .Where(step => step is not null)
                .Select(step => step!.Text("captureAs"))
                .Where(name => name.Length > 0)
                .ToList();
            var exports = meta.List("exports") ?? [];
            for (var exportIndex = 0; exportIndex < exports.Count; exportIndex++)
            {
                if (exports[exportIndex] is not string name || name.Length == 0
                    || captured.Contains(name, StringComparer.Ordinal))
                {
                    continue;
                }
                found.Add(Diagnostic.Error("E304", file,
                        document.At(string.Create(CultureInfo.InvariantCulture,
                            $"/metaSteps/{metaIndex}/exports/{exportIndex}")).Value,
                        string.Create(CultureInfo.InvariantCulture,
                            $"Meta step {meta.Text("name")} exports {name}, which none of its steps captures."))
                    .Suggest(Spelling.Nearest(name, captured, 2)));
            }
        }

        // E309: a vars value has to be the same on every run, because a
        // conformance run compares it. Only the determinism rule is checked on a
        // var: its paths resolve against parameters and other vars rather than a
        // case's captures.
        var blocks = new List<(string Pointer, OrderedMap Block)>();
        if (suite.Map("vars") is { } suiteVarBlock)
        {
            blocks.Add(("/vars", suiteVarBlock));
        }
        for (var index = 0; index < cases.Count; index++)
        {
            if (cases[index]?.Map("vars") is { } nested)
            {
                blocks.Add((string.Create(CultureInfo.InvariantCulture, $"/tests/{index}/vars"), nested));
            }
        }
        foreach (var (blockPointer, block) in blocks)
        {
            foreach (var name in block.Keys)
            {
                var pointer = blockPointer + "/" + SuiteDocument.Escape(name);
                foreach (var reference in Expression.References(block.Value(name), pointer))
                {
                    var reading = Expression.Read(reference.Text, true);
                    if (reading.Error is not { } refused
                        || !string.Equals(refused.Code, "E309", StringComparison.Ordinal))
                    {
                        continue;
                    }
                    found.Add(Diagnostic.Error("E309", file, document.At(reference.Pointer).Value,
                            string.Create(CultureInfo.InvariantCulture,
                                $"${{{reference.Text}}} cannot be used in vars: {refused.Message}."))
                        .Suggest("Pass the value in with --param, or capture it in a step where a changing value is fine."));
                }
            }
        }

        // W303: a declared parameter nothing reads.
        var suiteParams = Walk.Entries(suite, "params");
        for (var index = 0; index < suiteParams.Count; index++)
        {
            var param = suiteParams[index];
            if (param is null)
            {
                continue;
            }
            var name = param.Text("name");
            if (readParams.Contains(name))
            {
                continue;
            }
            found.Add(Diagnostic.Warning("W303", file,
                document.At(string.Create(CultureInfo.InvariantCulture, $"/params/{index}/name")).Value,
                string.Create(CultureInfo.InvariantCulture, $"Parameter {name} is declared and never read.")));
        }

        return found;
    }

    /// <summary>The run of letters, digits and underscores a piece of a script
    /// starts with, which is the capture name that followed `capture.`.</summary>
    private static string LeadingName(string piece)
    {
        var end = 0;
        while (end < piece.Length && (char.IsAsciiLetterOrDigit(piece[end]) || piece[end] == '_'))
        {
            end++;
        }
        return piece[..end];
    }
}
