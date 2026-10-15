using System.Globalization;
using Bdd.Suite.Diagnostics;
using Bdd.Suite.Extensions;
using Bdd.Suite.Model;
using Bdd.Suite.Schema;

namespace Bdd.Suite.Validation;

/// <summary>How one file is to be validated.</summary>
public sealed class ValidationOptions
{
    public string Binding { get; init; } = "csharp";
    public bool BindingCheck { get; init; }

    /// <summary>The --param pairs, in the order they were given, because a later
    /// one replaces an earlier one and a message names the first.</summary>
    public IReadOnlyList<KeyValuePair<string, string>> Params { get; init; } = [];

    /// <summary>The runtime's extensions: their context keys, lint rules and
    /// environment prefix. The core alone by default.</summary>
    public Composite Extensions { get; init; } = Composite.CoreOnly;
}

/// <summary>
/// Validation, in the three levels DEC-Y05 defines.
///
/// Structure sees the file and the schema. Semantics sees the parsed model and
/// the catalog. Dataflow sees the expanded model and the catalog. All three run
/// over one parse and everything they find is reported, because an author fixing
/// four typos should see four diagnostics.
/// </summary>
public static class Validator
{
    /// <summary>Every diagnostic for one suite file, in the one order every
    /// binding writes them.</summary>
    public static List<Diagnostic> File(
        string path, string relative, SuiteSchema schema, ValidationOptions options)
    {
        string text;
        try
        {
            text = System.IO.File.ReadAllText(path);
        }
        catch (IOException failure)
        {
            throw new IOException(string.Create(CultureInfo.InvariantCulture,
                $"{path} cannot be read: {failure.Message}"), failure);
        }

        SuiteDocument document;
        try
        {
            document = SuiteDocument.Load(text);
        }
        catch (LoadException failure)
        {
            return [Structure.Unparseable(relative, failure.Message, failure.Position)];
        }
        if (document.Value is not OrderedMap suite)
        {
            return [Structure.NotAMapping(relative)];
        }

        var library = Semantics.Imports(document, relative, path);
        var extensions = options.Extensions;
        var found = Structure.Check(document, relative, schema);
        found.AddRange(Semantics.Check(document, relative, schema, library,
            options.Binding, options.BindingCheck, options.Params, extensions.EnvPrefix));
        found.AddRange(Dataflow.Check(document, relative, schema, library, extensions.ContextKeys));
        // The extensions' own rules see the same parse and the same imports.
        found.AddRange(extensions.Lint(new RuleInput
        {
            Document = document, File = relative, Suite = suite, Library = library,
        }));
        return Findings.Sorted(found);
    }
}
