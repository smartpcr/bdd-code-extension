namespace Inventory.Suite;

using Bdd.Suite.Actions;
using Bdd.Suite.Extensions;

/// <summary>
/// The inventory extension of the suite runtime: every action
/// schema/actions.catalog.yaml declares, by name. The runtime's own core.* and
/// wait come from the runtime; suiterun and the generated tests install this
/// beside them.
///
/// One line per action, `["name"] = Handler,`: the shape the Suite Authoring
/// extension's C# recognizer reads for navigation and hover, and where its
/// *Declare action* and *Implement in C#* add the next registration (the
/// handler goes into InventoryActions).
/// </summary>
public sealed class InventoryExtension : IExtension
{
    private static readonly Dictionary<string, Func<ActionRequest, object?>> handlers = new(StringComparer.Ordinal)
    {
        ["store.open"] = InventoryActions.Open,
        ["store.close"] = InventoryActions.Close,

        ["stock.receive"] = InventoryActions.Receive,
        ["stock.ship"] = InventoryActions.Ship,
        ["stock.level"] = InventoryActions.Level,

        ["warehouse.sync"] = InventoryActions.Sync,
    };

    public string Name => "inventory";

    /// <summary>Every action this extension implements, sorted by name.</summary>
    public IReadOnlyList<ActionRegistration> Actions { get; } = handlers
        .OrderBy(entry => entry.Key, StringComparer.Ordinal)
        .Select(entry => new ActionRegistration(entry.Key, entry.Value))
        .ToList();

    /// <summary>
    /// The environment a guarded suite reaches. The Suite Authoring extension
    /// passes these three to every run of a guarded suite (bddSuite.lab.*); the
    /// generated tests read them as BDD_SUITE_OPTION_API_URL and so on.
    /// </summary>
    public IReadOnlyList<ExtensionOption> Options { get; } =
    [
        new("--api-url", "The warehouse service warehouse.sync sends to when its step names no endpoint."),
        new("--lab-id", "The environment's id, for the report."),
        new("--connection-file", "The environment's connection file."),
    ];

    /// <summary>Once per run: the environment the options name, handed to
    /// every action of this extension as <see cref="ActionRequest.State"/>.</summary>
    public RunState Start(IReadOnlyDictionary<string, string> options) => new()
    {
        State = new Target(
            options.GetValueOrDefault("--api-url") ?? string.Empty,
            options.GetValueOrDefault("--lab-id") ?? string.Empty,
            options.GetValueOrDefault("--connection-file") ?? string.Empty),
    };
}

/// <summary>The environment a run reaches; empty values when none was given.</summary>
public sealed record Target(string ApiUrl, string LabId, string ConnectionFile);
