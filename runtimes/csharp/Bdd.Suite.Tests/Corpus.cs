using System.Text.Json;
using Bdd.Suite.Model;
using Bdd.Suite.Walking;

namespace Bdd.Suite.Tests;

/// <summary>
/// The corpus every binding is held to.
///
/// Only the reading lives here. What each kind of entry means is in the test
/// files beside it, one per family, so that a failure names the family it came
/// from rather than one enormous test.
/// </summary>
public sealed class Corpus
{
    /// <summary>The repository root, which findings are relative to.</summary>
    public required string Root { get; init; }

    /// <summary>The corpus folder, conformance/.</summary>
    public required string Directory { get; init; }

    /// <summary>The schema folder the corpus is validated against: the
    /// manifest's schemaRoot, relative to the corpus folder.</summary>
    public string SchemaRoot
    {
        get
        {
            var named = Manifest().Text("schemaRoot");
            return Path(named.Length > 0 ? named : "schema");
        }
    }

    /// <summary>Locate the corpus from the test assembly or the working
    /// directory.</summary>
    public static Corpus Find() => new() { Root = Where.Repo, Directory = Where.Corpus };

    /// <summary>One corpus file, by its manifest-relative name.</summary>
    public string Path(string relative) =>
        System.IO.Path.Combine(Directory, relative.Replace('/', System.IO.Path.DirectorySeparatorChar));

    /// <summary>run-manifest.yaml, parsed.</summary>
    public OrderedMap Manifest() => Yaml("run-manifest.yaml");

    /// <summary>One corpus file, parsed as a mapping.</summary>
    public OrderedMap Yaml(string relative) =>
        SuiteDocument.Load(File.ReadAllText(Path(relative))).Value as OrderedMap
        ?? throw new IOException($"{relative} does not hold a YAML mapping");

    /// <summary>One corpus file, parsed as JSON into the same shapes the YAML
    /// reader produces, so one set of helpers reads both.</summary>
    public OrderedMap Json(string relative)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path(relative)));
        return FromJson(document.RootElement) as OrderedMap
            ?? throw new IOException($"{relative} does not hold a JSON object");
    }

    /// <summary>What encoding/json calls a value, as the model calls it.</summary>
    public static object? FromJson(JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
            {
                var map = new OrderedMap();
                foreach (var property in element.EnumerateObject())
                {
                    map.Set(property.Name, FromJson(property.Value));
                }
                return map;
            }
            case JsonValueKind.Array:
                return element.EnumerateArray().Select(FromJson).ToList();
            case JsonValueKind.String:
                return element.GetString();
            case JsonValueKind.True:
                return true;
            case JsonValueKind.False:
                return false;
            case JsonValueKind.Number:
                // JSON has one number type; the rest of this binding tells a
                // whole number from a fraction, so it is told here too. The two
                // branches are boxed separately on purpose: a conditional with a
                // long on one side and a double on the other has one type, and it
                // is double.
                if (element.TryGetInt64(out var whole))
                {
                    return whole;
                }
                return element.GetDouble();
            default:
                return null;
        }
    }

    /// <summary>The manifest entries of one kind, or all of them.</summary>
    public static List<OrderedMap> Entries(OrderedMap manifest, string kind)
    {
        var out_ = new List<OrderedMap>();
        foreach (var raw in manifest.List("entries") ?? [])
        {
            if (raw is not OrderedMap entry)
            {
                continue;
            }
            if (kind.Length == 0 || string.Equals(entry.Text("kind"), kind, StringComparison.Ordinal))
            {
                out_.Add(entry);
            }
        }
        return out_;
    }

    /// <summary>
    /// Whether the manifest marks this entry pending for a binding: the binding
    /// does not meet it yet, reports it as pending rather than passed, and is
    /// removed from the entry's pendingIn in the change that makes it pass.
    /// </summary>
    public static bool PendingIn(OrderedMap entry, string binding) =>
        (entry.List("pendingIn") ?? []).Any(name => name is string text && string.Equals(text, binding, StringComparison.Ordinal));

    /// <summary>
    /// Say which entries of a family were left pending: neither run nor counted
    /// as passed (conformance/README.md), but named in the test's output so a
    /// skipped entry is never silent.
    /// </summary>
    public static void ReportPending(Xunit.Abstractions.ITestOutputHelper output, string family, IReadOnlyCollection<string> pending)
    {
        output.WriteLine(pending.Count == 0
            ? $"{family}: no entry is pending in csharp"
            : $"{family}: {pending.Count} pending in csharp, not run: {string.Join(", ", pending)}");
    }

    /// <summary>Every action name a value names anywhere inside it.</summary>
    public static void CollectActions(object? value, HashSet<string> found)
    {
        switch (value)
        {
            case OrderedMap map:
                if (map.Value("action") is string name && name.Length > 0)
                {
                    found.Add(name);
                }
                foreach (var key in map.Keys)
                {
                    CollectActions(map.Value(key), found);
                }
                break;
            case List<object?> items:
                foreach (var item in items)
                {
                    CollectActions(item, found);
                }
                break;
        }
    }

    /// <summary>Every step list in a value, for a test that has to reach them
    /// all.</summary>
    public static List<StepList> StepLists(OrderedMap suite) => Walk.StepLists(suite);
}
