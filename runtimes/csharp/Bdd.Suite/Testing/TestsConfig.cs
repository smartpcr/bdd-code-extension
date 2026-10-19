using System.Globalization;
using Bdd.Suite.Model;

namespace Bdd.Suite.Testing;

/// <summary>Why a test-generation config cannot be used.</summary>
public sealed class TestsConfigException(string message) : Exception(message);

/// <summary>
/// One <c>bddsuite.tests.yaml</c> (spec/test-plan.md, spec/tests.config.schema.json):
/// which suites a test project runs, the schema they lint against, the test
/// framework, the extensions the run hook registers, what may run without an
/// opt-in, and how generated code is named. Paths are made absolute against
/// the file's own folder.
/// </summary>
public sealed class TestsConfig
{
    private static readonly HashSet<string> Keys = new(StringComparer.Ordinal)
    {
        "suites", "exclude", "schemaRoot", "provider", "extensions", "offlineActions", "contextKeys", "output",
    };

    private static readonly HashSet<string> OutputKeys = new(StringComparer.Ordinal) { "folder", "namespace", "package" };

    /// <summary>The providers a config may name.</summary>
    public static readonly IReadOnlyList<string> Providers =
        ["mstest", "nunit", "xunit", "go", "rust", "node", "vitest", "jest", "mocha", "pester"];

    public required string File { get; init; }

    public string Directory => Path.GetDirectoryName(File) ?? ".";

    public required IReadOnlyList<string> Suites { get; init; }

    public IReadOnlyList<string> Exclude { get; init; } = [];

    /// <summary>Absolute.</summary>
    public required string SchemaRoot { get; init; }

    /// <summary>Empty when the config leaves it to detection.</summary>
    public string Provider { get; init; } = string.Empty;

    public IReadOnlyList<string> Extensions { get; init; } = [];

    /// <summary>Null when the config has none, which guards nothing.</summary>
    public IReadOnlyList<string>? OfflineActions { get; init; }

    /// <summary>Context keys the extensions add, so the suites lint before
    /// the extensions themselves are loaded.</summary>
    public IReadOnlyList<string> ContextKeys { get; init; } = [];

    public string OutputFolder { get; init; } = string.Empty;

    public string Namespace { get; init; } = string.Empty;

    public string Package { get; init; } = string.Empty;

    /// <summary>Read one config file, refusing anything the schema would.</summary>
    public static TestsConfig Load(string path)
    {
        var full = Path.GetFullPath(path);
        string text;
        try
        {
            text = System.IO.File.ReadAllText(full);
        }
        catch (IOException failure)
        {
            throw new TestsConfigException($"{path} cannot be read: {failure.Message}");
        }
        OrderedMap map;
        try
        {
            map = SuiteDocument.Load(text).Value as OrderedMap
                ?? throw new TestsConfigException($"{path} does not hold a YAML mapping.");
        }
        catch (LoadException failure)
        {
            throw new TestsConfigException($"{path} is not valid YAML: {failure.Message}");
        }

        void Refuse(string why) => throw new TestsConfigException(string.Create(CultureInfo.InvariantCulture, $"{path}: {why}"));
        foreach (var key in map.Keys.Where(key => !Keys.Contains(key)))
        {
            Refuse($"{key} is not a config key (spec/tests.config.schema.json).");
        }
        List<string> Texts(string key, bool required)
        {
            if (!map.Has(key))
            {
                if (required)
                {
                    Refuse($"{key} is required.");
                }
                return [];
            }
            if (map.Value(key) is not List<object?> items || items.Any(item => item is not string { Length: > 0 }))
            {
                Refuse($"{key} is a list of non-empty strings.");
                return [];
            }
            return items.Cast<string>().ToList();
        }
        string Path_(string text)
        {
            if (text.Contains('\\', StringComparison.Ordinal))
            {
                Refuse($"{text} uses a backslash; paths use forward slashes.");
            }
            return text;
        }

        var suites = Texts("suites", required: true).Select(Path_).ToList();
        if (suites.Count == 0)
        {
            Refuse("suites names no glob.");
        }
        var schemaRoot = map.Text("schemaRoot");
        if (schemaRoot.Length == 0)
        {
            Refuse("schemaRoot is required.");
        }
        var provider = map.Text("provider");
        if (map.Has("provider") && !Providers.Contains(provider))
        {
            Refuse($"provider is one of {string.Join(", ", Providers)}, not {provider}.");
        }
        var offline = map.Has("offlineActions") ? Texts("offlineActions", required: false) : null;
        foreach (var pattern in offline ?? [])
        {
            var star = pattern.IndexOf('*', StringComparison.Ordinal);
            if (star >= 0 && (!pattern.EndsWith(".*", StringComparison.Ordinal) || star != pattern.Length - 1))
            {
                Refuse($"offlineActions: {pattern} is a name or prefix.*, with no other star.");
            }
        }
        var output = map.Map("output") ?? new OrderedMap();
        if (map.Has("output") && map.Value("output") is not OrderedMap)
        {
            Refuse("output is a mapping.");
        }
        foreach (var key in output.Keys.Where(key => !OutputKeys.Contains(key)))
        {
            Refuse($"output.{key} is not an output key.");
        }
        var directory = Path.GetDirectoryName(full) ?? ".";
        return new TestsConfig
        {
            File = full,
            Suites = suites,
            Exclude = Texts("exclude", required: false).Select(Path_).ToList(),
            SchemaRoot = Path.GetFullPath(Path.Combine(directory, Path_(schemaRoot))),
            Provider = provider,
            Extensions = Texts("extensions", required: false),
            OfflineActions = offline,
            ContextKeys = Texts("contextKeys", required: false),
            OutputFolder = output.Text("folder"),
            Namespace = output.Text("namespace"),
            Package = output.Text("package"),
        };
    }
}
