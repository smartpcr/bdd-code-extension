using System.Globalization;
using System.Text.Json.Nodes;
using Bdd.Suite.Diagnostics;
using Bdd.Suite.Model;
using Bdd.Suite.Schema;
using Bdd.Suite.Text;
using Bdd.Suite.Values;
using Bdd.Suite.Walking;
using Json.Schema;

namespace Bdd.Suite.Validation;

internal enum FailureKind
{
    /// <summary>A key the object has to carry and does not.</summary>
    Required,

    /// <summary>A key nothing declares, at the pointer of the key itself.</summary>
    Unexpected,

    /// <summary>Anything else: a wrong type, a value outside its range, a string
    /// that does not match. One message, at the value.</summary>
    Refused,
}

internal sealed record SchemaFailure(string Pointer, FailureKind Kind, string Name, string Message);

/// <summary>
/// E100 to E105: the file parses, its keys are spelled and typed the way the
/// schema says, and every step's parameters belong to its action.
///
/// Two passes, for the reason DEC-Y05 gives. The first checks the whole document
/// against the generated schema with the step union swapped for the envelope,
/// because a validator that reports every unselected branch of a union reports
/// four problems where there is one. The second checks each step against the one
/// branch its action selects, so an unknown parameter is E105 and names the
/// action rather than being one of four "no branch matched" messages.
/// </summary>
public static class Structure
{
    /// <summary>The one finding a file that will not parse produces.</summary>
    public static Diagnostic Unparseable(string file, string message, Position position) =>
        Diagnostic.Error("E100", file, position, "The file is not valid YAML: " + message);

    /// <summary>The one finding a file that parses but is not a suite
    /// produces.</summary>
    public static Diagnostic NotAMapping(string file) =>
        Diagnostic.Error("E100", file, Position.Start,
            "The file does not hold a YAML mapping, so it cannot be a suite.");

    /// <summary>A pointer as something a suite author recognises.</summary>
    private static string PointerName(string pointer) =>
        pointer.Length == 0 ? "the suite" : "the suite at " + pointer;

    /// <summary>Whether a pointer has a given shape, with # standing for any
    /// index.</summary>
    internal static bool IsShaped(string pointer, params string[] shape)
    {
        if (pointer.Length == 0)
        {
            return false;
        }
        var segments = pointer.Split('/').Skip(1).ToArray();
        if (segments.Length != shape.Length)
        {
            return false;
        }
        for (var index = 0; index < shape.Length; index++)
        {
            if (string.Equals(shape[index], "#", StringComparison.Ordinal))
            {
                if (segments[index].Length == 0 || !segments[index].All(char.IsAsciiDigit))
                {
                    return false;
                }
                continue;
            }
            if (!string.Equals(segments[index], shape[index], StringComparison.Ordinal))
            {
                return false;
            }
        }
        return true;
    }

    /// <summary>
    /// What kind of place a pointer names, and which keys are legal there.
    ///
    /// Read out of the schema and the catalog rather than listed here, so a key
    /// added to either is offered without this function changing.
    /// </summary>
    private static (string Action, List<string> Keys) LegalKeys(
        string pointer, SuiteSchema schema, StepEntry? step)
    {
        if (step is not null)
        {
            var action = step.Step.Text("action");
            if (schema.Actions.TryGetValue(action, out var declared))
            {
                var keys = new List<string>(schema.StepCommonKeys);
                keys.AddRange(declared.Params);
                return (action, keys);
            }
            return (string.Empty, PropertiesOf(schema.Defs["step.meta"]));
        }

        JsonNode? definition = null;
        if (pointer.Length == 0)
        {
            definition = schema.Document;
        }
        else if (string.Equals(pointer, "/defaults", StringComparison.Ordinal))
        {
            definition = schema.Defs["defaults"];
        }
        else if (IsShaped(pointer, "tests", "#"))
        {
            definition = schema.Defs["case"];
        }
        else if (IsShaped(pointer, "tests", "#", "asserts", "#"))
        {
            definition = schema.Defs["assert"];
        }
        else if (IsShaped(pointer, "metaSteps", "#"))
        {
            definition = schema.Defs["metaStep"];
        }
        else if (IsShaped(pointer, "metaSteps", "#", "params", "#"))
        {
            definition = schema.Defs["metaParamDecl"];
        }
        else if (char.IsAsciiDigit(pointer[^1]) && pointer.Contains("params/", StringComparison.Ordinal))
        {
            definition = schema.Defs["paramDecl"];
        }
        return (string.Empty, PropertiesOf(definition));
    }

    private static List<string> PropertiesOf(JsonNode? definition)
    {
        if (definition is not JsonObject held || held["properties"] is not JsonObject properties)
        {
            return [];
        }
        var names = properties.Select(pair => pair.Key).ToList();
        names.Sort(StringComparer.Ordinal);
        return names;
    }

    /// <summary>The whole value as the plain JSON the validator walks.</summary>
    public static JsonNode? ToJson(object? value)
    {
        switch (value)
        {
            case null:
                return null;
            case OrderedMap map:
            {
                var out_ = new JsonObject();
                foreach (var key in map.Keys)
                {
                    out_[key] = ToJson(map.Value(key));
                }
                return out_;
            }
            case List<object?> items:
            {
                var out_ = new JsonArray();
                foreach (var item in items)
                {
                    out_.Add(ToJson(item));
                }
                return out_;
            }
            case string text:
                return JsonValue.Create(text);
            case bool yes:
                return JsonValue.Create(yes);
            case long whole:
                return JsonValue.Create(whole);
            case double fraction:
                return JsonValue.Create(fraction);
            default:
                return JsonValue.Create(Value.Text(value));
        }
    }

    /// <summary>Everything one schema refused about one document.</summary>
    private static List<SchemaFailure> Failures(JsonObject document, JsonNode? instance)
    {
        var compiled = JsonSchema.FromText(document.ToJsonString());
        var options = new EvaluationOptions
        {
            OutputFormat = OutputFormat.List,
            EvaluateAs = SpecVersion.Draft202012,
        };
        var result = compiled.Evaluate(instance, options);
        var found = new List<SchemaFailure>();
        Collect(result, found);
        return found;
    }

    /// <summary>
    /// Flatten the validator's tree of results into the leaves that name a real
    /// problem. A node that only says something underneath failed would double
    /// every finding if it were reported as well.
    /// </summary>
    private static void Collect(EvaluationResults results, List<SchemaFailure> found)
    {
        if (results.IsValid)
        {
            return;
        }
        if (results.Errors is { Count: > 0 })
        {
            var pointer = results.InstanceLocation.ToString();
            foreach (var (keyword, message) in results.Errors)
            {
                if (string.Equals(keyword, "required", StringComparison.Ordinal))
                {
                    foreach (var name in QuotedNames(message))
                    {
                        found.Add(new SchemaFailure(pointer, FailureKind.Required, name, message));
                    }
                    continue;
                }
                // `additionalProperties: false` reaches here as a false schema
                // under no keyword at all, reported at the key it refused rather
                // than at the object that refused it. That is the one place this
                // library differs from the others in shape, and not in what it
                // says: the pointer is already the key, so the name is its last
                // segment.
                if (keyword.Length == 0)
                {
                    var at = pointer.LastIndexOf('/');
                    var name = at >= 0 ? pointer[(at + 1)..] : pointer;
                    found.Add(new SchemaFailure(pointer, FailureKind.Unexpected, Unescape(name), message));
                    continue;
                }
                found.Add(new SchemaFailure(pointer, FailureKind.Refused, string.Empty, message));
            }
        }
        foreach (var nested in results.Details)
        {
            Collect(nested, found);
        }
    }

    /// <summary>
    /// The property names a `required` message lists.
    ///
    /// The library states them inside its own sentence rather than beside it -
    /// `Required properties ["name"] are not present` - so they are read back out
    /// of the quoted parts. Sorted, because two runs must not disagree about the
    /// order either.
    /// </summary>
    internal static List<string> QuotedNames(string message)
    {
        var names = new List<string>();
        var at = 0;
        while (true)
        {
            var open = message.IndexOf('"', at);
            if (open < 0)
            {
                break;
            }
            var close = message.IndexOf('"', open + 1);
            if (close < 0)
            {
                break;
            }
            var name = message[(open + 1)..close];
            if (name.Length > 0 && !names.Contains(name, StringComparer.Ordinal))
            {
                names.Add(name);
            }
            at = close + 1;
        }
        names.Sort(StringComparer.Ordinal);
        return names;
    }

    private static string Unescape(string segment) =>
        segment.Replace("~1", "/", StringComparison.Ordinal).Replace("~0", "~", StringComparison.Ordinal);

    private static Diagnostic ToDiagnostic(
        SchemaFailure failure, SuiteDocument document, string file, SuiteSchema schema, StepEntry? step)
    {
        switch (failure.Kind)
        {
            case FailureKind.Required:
                return Diagnostic.Error("E102", file, document.At(failure.Pointer).Key,
                    string.Create(CultureInfo.InvariantCulture,
                        $"Required key {failure.Name} is missing from {PointerName(failure.Pointer)}."));
            case FailureKind.Unexpected:
            {
                var at = failure.Pointer.LastIndexOf('/');
                var parent = at >= 0 ? failure.Pointer[..at] : string.Empty;
                var (action, legal) = LegalKeys(parent, schema, step);
                var suggestion = Spelling.Nearest(failure.Name, legal, 2);
                var position = document.At(failure.Pointer).Key;
                var finding = action.Length > 0
                    ? Diagnostic.Error("E105", file, position, string.Create(CultureInfo.InvariantCulture,
                        $"Action {action} takes no parameter {failure.Name}."))
                    : Diagnostic.Error("E101", file, position, string.Create(CultureInfo.InvariantCulture,
                        $"Unknown key {failure.Name} in {PointerName(parent)}."));
                return suggestion.Length > 0 ? finding.Suggest("Did you mean " + suggestion) : finding;
            }
            default:
                return Diagnostic.Error("E103", file, document.At(failure.Pointer).Value,
                    string.Create(CultureInfo.InvariantCulture,
                        $"{PointerName(failure.Pointer)} has a value the schema refuses: {failure.Message}."));
        }
    }

    /// <summary>The structural pass.</summary>
    public static List<Diagnostic> Check(SuiteDocument document, string file, SuiteSchema schema)
    {
        var found = new List<Diagnostic>();
        var suite = document.Value as OrderedMap;

        foreach (var failure in Failures(schema.Document, ToJson(document.Value)))
        {
            found.Add(ToDiagnostic(failure, document, file, schema, null));
        }

        // One branch per step, selected by its action name.
        var branches = new JsonArray();
        var documents = new JsonArray();
        var checked_ = new List<StepEntry>();
        foreach (var entry in Walk.AllSteps(suite))
        {
            var action = entry.Step.Text("action");
            if (action.Length > 0)
            {
                if (!schema.Has(action))
                {
                    var suggestion = Spelling.Nearest(action, schema.ActionNames, 3);
                    var finding = Diagnostic.Error("E104", file,
                        document.At(entry.Pointer + "/action").Value,
                        string.Create(CultureInfo.InvariantCulture, $"Unknown action {action}."));
                    found.Add(suggestion.Length > 0
                        ? finding.Suggest("Did you mean " + suggestion)
                        : finding.Suggest("No action of that name is declared in actions.catalog.yaml."));
                    continue;
                }
                branches.Add(new JsonObject { ["$ref"] = "#/$defs/step." + action });
            }
            else if (entry.Step.Present("meta"))
            {
                branches.Add(new JsonObject { ["$ref"] = "#/$defs/step.meta" });
            }
            else
            {
                found.Add(Diagnostic.Error("E102", file, document.At(entry.Pointer).Key,
                    "A step declares no action and no meta. One of the two is required."));
                continue;
            }
            documents.Add(ToJson(entry.Step));
            checked_.Add(entry);
        }
        // A step list entry that is not a mapping at all never reaches the branch
        // check, because there is no action to select a branch by.
        found.AddRange(NotMappings(document, file, suite));

        if (checked_.Count > 0)
        {
            var stepSchema = new JsonObject
            {
                ["$schema"] = "https://json-schema.org/draft/2020-12/schema",
                ["type"] = "object",
                ["properties"] = new JsonObject
                {
                    ["steps"] = new JsonObject { ["type"] = "array", ["prefixItems"] = branches },
                },
                ["$defs"] = schema.Defs.DeepClone(),
            };
            var instance = new JsonObject { ["steps"] = documents };
            foreach (var failure in Failures(stepSchema, instance))
            {
                if (!failure.Pointer.StartsWith("/steps/", StringComparison.Ordinal))
                {
                    continue;
                }
                var rest = failure.Pointer["/steps/".Length..];
                var slash = rest.IndexOf('/', StringComparison.Ordinal);
                var head = slash >= 0 ? rest[..slash] : rest;
                var tail = slash >= 0 ? rest[slash..] : string.Empty;
                if (!int.TryParse(head, NumberStyles.Integer, CultureInfo.InvariantCulture, out var index)
                    || index < 0 || index >= checked_.Count)
                {
                    continue;
                }
                var entry = checked_[index];
                found.Add(ToDiagnostic(
                    failure with { Pointer = entry.Pointer + tail }, document, file, schema, entry));
            }
        }

        return found;
    }

    /// <summary>E103 for every entry of a step list that is not a mapping.</summary>
    private static List<Diagnostic> NotMappings(SuiteDocument document, string file, OrderedMap? suite)
    {
        var found = new List<Diagnostic>();
        foreach (var list in Walk.StepLists(suite))
        {
            for (var index = 0; index < list.Steps.Count; index++)
            {
                // A blank entry is a hole in the list, not a broken step. The
                // schema refuses it where it matters and the walk skips it.
                if (list.Steps[index] is null or OrderedMap)
                {
                    continue;
                }
                found.Add(Diagnostic.Error("E103", file,
                    document.At(string.Create(CultureInfo.InvariantCulture, $"{list.Pointer}/{index}")).Value,
                    "A step must be a mapping with an action."));
            }
        }
        return found;
    }
}
