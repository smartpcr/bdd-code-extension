using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Bdd.Suite.Diagnostics;
using Bdd.Suite.Execution;
using Bdd.Suite.Extensions;
using Bdd.Suite.Model;
using Bdd.Suite.Schema;
using Bdd.Suite.Validation;
using Bdd.Suite.Walking;

namespace Bdd.Suite.Testing;

/// <summary>One case of a test plan: a test the generated code declares.</summary>
public sealed record PlanCase(string Name, string Id, IReadOnlyList<string> Tags, string? Outline, OrderedMap? Row);

/// <summary>One suite of a test plan: a test class, function or file.</summary>
public sealed record PlanSuite(
    string File, string FullPath, string Name, string Id, IReadOnlyList<string> Tags,
    bool Guarded, IReadOnlyList<string> GuardedBy, IReadOnlyList<PlanCase> Cases);

/// <summary>A plan, or the findings that refused it.</summary>
public sealed record PlanResult(TestPlan? Plan, IReadOnlyList<Diagnostic> Findings);

/// <summary>
/// The test plan (spec/test-plan.md): the suites and cases generated code
/// declares, with their identifiers, tags and guards. Five runtimes build the
/// same plan from the same config (conformance/generate/).
/// </summary>
public sealed class TestPlan
{
    public required TestsConfig Config { get; init; }

    public required IReadOnlyList<PlanSuite> Suites { get; init; }

    /// <summary>Build the plan, or refuse it with the findings of every suite
    /// that does not lint clean (nothing is generated from a partial plan).</summary>
    public static PlanResult Build(TestsConfig config)
    {
        var schema = SuiteSchema.Load(config.SchemaRoot);
        // The suites lint before any extension is loaded, so the context keys
        // the extensions add come from the config.
        var stand_in = Composite.Compose(new Extension { Name = "the config's context keys", ContextKeys = config.ContextKeys });
        var settings = new ValidationOptions { Extensions = stand_in };

        var loaded = new List<(string Relative, string Full, OrderedMap Suite)>();
        var findings = new List<Diagnostic>();
        foreach (var relative in Globs.Select(config.Directory, config.Suites, config.Exclude))
        {
            var full = Path.GetFullPath(Path.Combine(config.Directory, relative));
            // A library declares and never runs: only a file with a suite key is a suite.
            if (SuiteDocument.Load(File.ReadAllText(full)).Value is not OrderedMap suite || !suite.Has("suite"))
            {
                continue;
            }
            findings.AddRange(Validator.File(full, relative, schema, settings));
            loaded.Add((relative, full, suite));
        }
        findings = Findings.Sorted(findings);
        if (Findings.Fails(findings, strict: false))
        {
            return new PlanResult(null, findings);
        }

        var suiteIds = new Identifiers();
        var suites = new List<PlanSuite>();
        foreach (var (relative, full, suite) in loaded)
        {
            var name = suite.Text("suite");
            var caseIds = new Identifiers(Identifiers.ReservedInSuite);
            var cases = new List<PlanCase>();
            foreach (var held in Walk.Entries(suite, "tests").OfType<OrderedMap>())
            {
                var outline = held.Value("examples") is List<object?> { Count: > 0 } ? held.Text("name") : null;
                foreach (var one in SuiteExpansion.ExpandOutline(held))
                {
                    var caseName = one.Text("name");
                    cases.Add(new PlanCase(
                        caseName, caseIds.Take(caseName, "Case"), Distinct(SuiteExpansion.CaseTags(suite, one)),
                        outline, outline is null ? null : one.Map("__row")));
                }
            }
            var guardedBy = config.OfflineActions is { } offline
                ? Actions(suite, full).Where(action => !offline.Any(pattern => Covers(pattern, action)))
                    .Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList()
                : [];
            suites.Add(new PlanSuite(
                relative, full, name, suiteIds.Take(name, "Suite"), Distinct(suite.List("tags")?.OfType<string>() ?? []),
                guardedBy.Count > 0, guardedBy, cases));
        }
        return new PlanResult(new TestPlan { Config = config, Suites = suites }, findings);
    }

    /// <summary>Whether an offlineActions pattern covers an action: the name
    /// itself, or prefix.* and a name starting with the prefix and its dot.</summary>
    public static bool Covers(string pattern, string action) =>
        pattern.EndsWith('*')
            ? action.StartsWith(pattern[..^1], StringComparison.Ordinal)
            : string.Equals(pattern, action, StringComparison.Ordinal);

    /// <summary>Every action a suite can run: its hooks and every case's
    /// phases, meta steps expanded (imported ones too), and the step each
    /// wait polls.</summary>
    public static IEnumerable<string> Actions(OrderedMap suite, string path)
    {
        var library = SuiteExpansion.ReadLibraries(suite, path);
        var definitions = SuiteExpansion.MetaDefinitions(suite, library);
        var lists = SuiteExpansion.ExpandedHooks(suite, definitions).Values
            .Concat(SuiteExpansion.Cases(suite).SelectMany(held => SuiteExpansion.ExpandedCase(held, definitions).Values));
        foreach (var steps in lists)
        {
            foreach (var step in steps)
            {
                for (var current = step; current is not null; current = current.Map("forStep"))
                {
                    if (current.Text("action") is { Length: > 0 } action)
                    {
                        yield return action;
                    }
                }
            }
        }
    }

    private static List<string> Distinct(IEnumerable<string> tags) => tags.Distinct(StringComparer.Ordinal).ToList();

    /// <summary>The plan as spec/test-plan.schema.json describes it, indented,
    /// UTF-8 text with non-ASCII characters as themselves.</summary>
    public string ToJson()
    {
        using var stream = new MemoryStream();
        using (var json = new Utf8JsonWriter(stream, new JsonWriterOptions
        {
            Indented = true,
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        }))
        {
            json.WriteStartObject();
            json.WriteNumber("planVersion", 1);
            json.WriteStartArray("suites");
            foreach (var suite in Suites)
            {
                json.WriteStartObject();
                json.WriteString("file", suite.File);
                json.WriteString("name", suite.Name);
                json.WriteString("id", suite.Id);
                Strings(json, "tags", suite.Tags);
                json.WriteBoolean("guarded", suite.Guarded);
                Strings(json, "guardedBy", suite.GuardedBy);
                json.WriteStartArray("cases");
                foreach (var one in suite.Cases)
                {
                    json.WriteStartObject();
                    json.WriteString("name", one.Name);
                    json.WriteString("id", one.Id);
                    if (one.Outline is not null)
                    {
                        json.WriteString("outline", one.Outline);
                        json.WritePropertyName("row");
                        Value(json, one.Row);
                    }
                    Strings(json, "tags", one.Tags);
                    json.WriteEndObject();
                }
                json.WriteEndArray();
                json.WriteEndObject();
            }
            json.WriteEndArray();
            json.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static void Strings(Utf8JsonWriter json, string name, IEnumerable<string> values)
    {
        json.WriteStartArray(name);
        foreach (var value in values)
        {
            json.WriteStringValue(value);
        }
        json.WriteEndArray();
    }

    private static void Value(Utf8JsonWriter json, object? value)
    {
        switch (value)
        {
            case null:
                json.WriteNullValue();
                break;
            case string text:
                json.WriteStringValue(text);
                break;
            case bool flag:
                json.WriteBooleanValue(flag);
                break;
            case long whole:
                json.WriteNumberValue(whole);
                break;
            case double real:
                json.WriteNumberValue(real);
                break;
            case OrderedMap map:
                json.WriteStartObject();
                foreach (var key in map.Keys)
                {
                    json.WritePropertyName(key);
                    Value(json, map.Value(key));
                }
                json.WriteEndObject();
                break;
            case List<object?> items:
                json.WriteStartArray();
                foreach (var item in items)
                {
                    Value(json, item);
                }
                json.WriteEndArray();
                break;
            default:
                json.WriteStringValue(Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture));
                break;
        }
    }
}
