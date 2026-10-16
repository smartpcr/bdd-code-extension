using Bdd.Suite.Extensions;

namespace Shop.Suite;

/// <summary>
/// The sample workspace's extension, C# binding: its shop actions, the context
/// key store and the option --store that sets it.
/// </summary>
public sealed class ShopExtension : IExtension
{
    public string Name => "shop";

    public IReadOnlyList<ActionRegistration> Actions => Suite.Actions.All;

    public IReadOnlyList<string> ContextKeys { get; } = ["store"];

    public IReadOnlyList<ExtensionOption> Options { get; } =
        [new ExtensionOption("--store", "The store ${store} reads (main by default).")];

    public RunState Start(IReadOnlyDictionary<string, string> options)
    {
        var store = options.TryGetValue("--store", out var given) && given.Length > 0 ? given : "main";
        return new RunState
        {
            Context = new Dictionary<string, object?>(StringComparer.Ordinal) { ["store"] = store },
            State = store,
        };
    }
}
