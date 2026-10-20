using Bdd.Suite.Extensions;

namespace Greeter.Suite;

/// <summary>
/// The greeter's extension: what a consumer writes to add its own actions to
/// the runtime. Its binding program and its generated tests both load it.
/// </summary>
public sealed class GreeterExtension : IExtension
{
    public string Name => "greeter";

    public IReadOnlyList<ActionRegistration> Actions { get; } =
    [
        new ActionRegistration("greet.say", request => Greeting($"Hello, {request.Step.Text("name")}!")),
        new ActionRegistration("greet.shout", request => Greeting($"HELLO, {request.Step.Text("name").ToUpperInvariant()}!")),
    ];

    private static Dictionary<string, object?> Greeting(string text) => new(StringComparer.Ordinal) { ["text"] = text };
}
