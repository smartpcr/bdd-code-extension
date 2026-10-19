using Bdd.Suite.Actions;
using Bdd.Suite.Extensions;

namespace Shop.Suite.MsTest;

/// <summary>
/// What the conformance corpus needs from a runtime's extension
/// (conformance/README.md): the context keys its suites read, with the values
/// of expressions/context.yaml, and fixture.append, which changes the list it
/// is given in place (execute/capture-isolation.yml).
/// </summary>
public sealed class CorpusExtension : IExtension
{
    public string Name => "the corpus";

    public IReadOnlyList<string> ContextKeys { get; } = ["cluster", "target", "labId", "apiUrl"];

    public IReadOnlyList<ActionRegistration> Actions { get; } =
    [
        new ActionRegistration("fixture.append", request =>
        {
            if (request.Step.Value("list") is not List<object?> list)
            {
                throw ActionException.Failed("fixture.append: list must be a list");
            }
            list.Add(request.Step.Value("item"));
            return list;
        }),
    ];

    public RunState Start(IReadOnlyDictionary<string, string> options) => new()
    {
        Context = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["cluster"] = "HOST-CL01",
            ["target"] = "HOST-N1",
            ["labId"] = "lab1",
            ["apiUrl"] = "http://api/api/v1",
        },
    };
}
