using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Bdd.Suite.Model;

namespace Bdd.Suite.Schema;

/// <summary>One action as the catalog declares it.</summary>
public sealed class CatalogAction
{
    public required string Name { get; init; }
    public List<string> Bindings { get; init; } = [];
    public bool Interruptible { get; set; } = true;
    public bool Deprecated { get; set; }
    public List<string> Params { get; init; } = [];

    /// <summary>The shape of what the action captures, or nothing when the
    /// catalog leaves it open. Only a closed shape can be checked, which is what
    /// keeps E302 honest about an API response nobody has declared.</summary>
    public object? Captures { get; set; }
}

/// <summary>
/// The vocabulary every runtime shares: the generated schema and the action
/// catalog, read from files at run time.
///
/// Nothing here is compiled in. suite.schema.json and actions.catalog.yaml are
/// the same two files the other runtimes read and the spec's Build-Schema.ps1
/// writes, so a runtime cannot hold an opinion about the format that the others
/// do not share.
///
/// A catalog may import other catalogs (DEC-S10): imports first, depth first in
/// listed order, each relative to the file that names it, then the catalog's
/// own actions. A name declared twice is refused naming both files, and an
/// import cycle is refused.
/// </summary>
public sealed class SuiteSchema
{
    /// <summary>The generated schema with its conditional step union swapped for
    /// the envelope. Steps are checked one branch at a time afterwards, because a
    /// validator that reports every unselected branch reports four problems where
    /// there is one.</summary>
    public required JsonObject Document { get; init; }

    public required JsonObject Defs { get; init; }
    public required Dictionary<string, CatalogAction> Actions { get; init; }
    public required List<string> ActionNames { get; init; }
    public required List<string> AssertOperators { get; init; }
    public required List<string> StepCommonKeys { get; init; }

    /// <summary>Whether the catalog declares an action.</summary>
    public bool Has(string name) => Actions.ContainsKey(name);

    /// <summary>Read suite.schema.json and actions.catalog.yaml from one
    /// directory.</summary>
    public static SuiteSchema Load(string schemaRoot)
    {
        var schemaPath = Path.Combine(schemaRoot, "suite.schema.json");
        var catalogPath = Path.Combine(schemaRoot, "actions.catalog.yaml");
        foreach (var path in new[] { schemaPath, catalogPath })
        {
            if (!File.Exists(path))
            {
                throw new IOException(string.Create(CultureInfo.InvariantCulture,
                    $"Suite schema not found at {path}. Generate it with the spec's Build-Schema.ps1 -Catalog <catalog>."));
            }
        }

        var document = JsonNode.Parse(File.ReadAllText(schemaPath)) as JsonObject
            ?? throw new IOException($"{schemaPath} does not hold a JSON object.");
        var defs = document["$defs"] as JsonObject
            ?? throw new IOException("suite.schema.json carries no $defs.");
        var envelope = defs["stepEnvelope"]?.DeepClone()
            ?? throw new IOException("suite.schema.json carries no stepEnvelope definition.");

        var assertOperators = PropertyNames(defs["assert"]).Where(name => name != "var").ToList();
        var stepCommonKeys = PropertyNames(defs["stepCommon"]);
        defs["step"] = envelope;

        var actions = new Dictionary<string, CatalogAction>(StringComparer.Ordinal);
        var declaredIn = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (held, file) in CatalogEntries(catalogPath, []))
        {
            var name = held.Text("name");
            if (name.Length == 0)
            {
                continue;
            }
            if (declaredIn.TryGetValue(name, out var first))
            {
                throw new IOException(string.Create(CultureInfo.InvariantCulture,
                    $"Action {name} is declared twice: in {first} and in {file}."));
            }
            declaredIn[name] = file;
            var action = new CatalogAction
            {
                Name = name,
                Interruptible = held.Value("interruptible") as bool? ?? true,
                Deprecated = held.Value("deprecated") as bool? ?? false,
                Captures = held.Value("captures"),
            };
            foreach (var binding in held.List("bindings") ?? [])
            {
                if (binding is string text)
                {
                    action.Bindings.Add(text);
                }
            }
            foreach (var declared in held.List("params") ?? [])
            {
                if (declared is OrderedMap shape && shape.Text("name").Length > 0)
                {
                    action.Params.Add(shape.Text("name"));
                }
            }
            actions[name] = action;
        }
        var names = actions.Keys.ToList();
        names.Sort(StringComparer.Ordinal);

        return new SuiteSchema
        {
            Document = document,
            Defs = defs,
            Actions = actions,
            ActionNames = names,
            AssertOperators = assertOperators,
            StepCommonKeys = stepCommonKeys,
        };
    }

    /// <summary>Every action entry of a catalog and of the catalogs it imports,
    /// each with the file that declares it: imports first, depth first in listed
    /// order, then the catalog's own.</summary>
    private static List<(OrderedMap Entry, string File)> CatalogEntries(string file, List<string> visiting)
    {
        var key = Path.GetFullPath(file);
        if (visiting.Contains(key, StringComparer.OrdinalIgnoreCase))
        {
            throw new IOException(string.Create(CultureInfo.InvariantCulture,
                $"Catalog import cycle: {string.Join(" -> ", visiting.Append(key))}"));
        }
        OrderedMap catalog;
        try
        {
            catalog = SuiteDocument.Load(File.ReadAllText(key)).Value as OrderedMap
                ?? throw new IOException($"{file} does not hold a YAML mapping.");
        }
        catch (LoadException failure)
        {
            throw new IOException($"{file} is not YAML: {failure.Message}", failure);
        }
        var out_ = new List<(OrderedMap Entry, string File)>();
        var inside = new List<string>(visiting) { key };
        var directory = Path.GetDirectoryName(key) ?? ".";
        foreach (var raw in catalog.List("imports") ?? [])
        {
            if (raw is not string name || name.Length == 0)
            {
                continue;
            }
            var imported = Path.GetFullPath(Path.Combine(directory, name));
            if (!File.Exists(imported))
            {
                throw new IOException(string.Create(CultureInfo.InvariantCulture,
                    $"{file} imports {name}, which does not exist ({imported})."));
            }
            out_.AddRange(CatalogEntries(imported, inside));
        }
        foreach (var entry in catalog.List("actions") ?? [])
        {
            if (entry is OrderedMap held)
            {
                out_.Add((held, key));
            }
        }
        return out_;
    }

    /// <summary>The properties one definition declares, sorted, so a suggestion
    /// list does not depend on the order a reader happened to produce.</summary>
    private static List<string> PropertyNames(JsonNode? definition)
    {
        if (definition is not JsonObject held || held["properties"] is not JsonObject properties)
        {
            return [];
        }
        var names = properties.Select(pair => pair.Key).ToList();
        names.Sort(StringComparer.Ordinal);
        return names;
    }

    /// <summary>
    /// The same schema with a corpus catalog overlay merged into it.
    ///
    /// An overlay exists so a rule the catalog drives - a deprecated action, a
    /// parameter the shipped catalog does not declare - can be proved without
    /// changing the catalog every binding reads. Merge by action name: each key
    /// given replaces the key in the shipped catalog, and a params entry replaces
    /// the one with the same name or is appended when there is none.
    ///
    /// The generated step branch is patched alongside the catalog, because the
    /// structural pass checks a step against #/$defs/step.&lt;action&gt; and the
    /// catalog is what that branch was generated from. Regenerating it in full
    /// would mean running the generator, which is a PowerShell script; adding the
    /// parameter the overlay declares is the part of that generation an overlay
    /// can change.
    /// </summary>
    public SuiteSchema WithOverlay(object? overlay)
    {
        var copied = Clone();
        if (overlay is not OrderedMap held)
        {
            return copied;
        }
        foreach (var raw in held.List("actions") ?? [])
        {
            if (raw is not OrderedMap patch)
            {
                continue;
            }
            var name = patch.Text("name");
            if (name.Length == 0)
            {
                continue;
            }
            if (!copied.Actions.TryGetValue(name, out var action))
            {
                throw new IOException(string.Create(CultureInfo.InvariantCulture,
                    $"The overlay patches {name}, which the catalog does not declare."));
            }
            if (patch.Value("deprecated") is bool deprecated)
            {
                action.Deprecated = deprecated;
            }
            if (patch.Has("bindings"))
            {
                action.Bindings.Clear();
                foreach (var binding in patch.List("bindings") ?? [])
                {
                    if (binding is string text)
                    {
                        action.Bindings.Add(text);
                    }
                }
            }
            if (patch.Value("interruptible") is bool interruptible)
            {
                action.Interruptible = interruptible;
            }
            foreach (var raw2 in patch.List("params") ?? [])
            {
                if (raw2 is not OrderedMap declaration)
                {
                    continue;
                }
                var paramName = declaration.Text("name");
                if (paramName.Length == 0)
                {
                    continue;
                }
                if (!action.Params.Contains(paramName, StringComparer.Ordinal))
                {
                    action.Params.Add(paramName);
                }
                if (copied.Defs["step." + name] is not JsonObject branch
                    || branch["properties"] is not JsonObject properties)
                {
                    continue;
                }
                var shape = new JsonObject();
                if (declaration.Value("type") is string kind)
                {
                    shape["type"] = kind;
                }
                if (declaration.Value("description") is string description)
                {
                    shape["description"] = description;
                }
                properties[paramName] = shape;
            }
        }
        return copied;
    }

    /// <summary>A copy deep enough that patching one does not patch the
    /// other.</summary>
    private SuiteSchema Clone()
    {
        var document = JsonNode.Parse(Document.ToJsonString(new JsonSerializerOptions())) as JsonObject
            ?? throw new InvalidOperationException("the schema could not be copied.");
        var defs = document["$defs"] as JsonObject ?? new JsonObject();
        var actions = new Dictionary<string, CatalogAction>(StringComparer.Ordinal);
        foreach (var (name, action) in Actions)
        {
            var copied = new CatalogAction
            {
                Name = action.Name,
                Interruptible = action.Interruptible,
                Deprecated = action.Deprecated,
                Captures = action.Captures,
            };
            copied.Bindings.AddRange(action.Bindings);
            copied.Params.AddRange(action.Params);
            actions[name] = copied;
        }
        return new SuiteSchema
        {
            Document = document,
            Defs = defs,
            Actions = actions,
            ActionNames = [.. ActionNames],
            AssertOperators = [.. AssertOperators],
            StepCommonKeys = [.. StepCommonKeys],
        };
    }
}
