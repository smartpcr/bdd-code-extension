using System.Globalization;
using Bdd.Suite.Actions;
using Bdd.Suite.Diagnostics;
using Bdd.Suite.Extensions;
using Bdd.Suite.Model;

namespace Bdd.Suite.Example;

/// <summary>
/// An example extension (E3): what a workspace writes to add to the runtime
/// without editing it. It uses only the library's public types.
///
/// It adds one of each part of the extension API:
///
///   action       example.echo    returns its text, prefixed with the region
///   context key  region          ${region} in any expression
///   option       --region        where the region comes from
///   rule         a ceiling       a suite tagged slow keeps every case within 10 seconds
/// </summary>
public sealed class EchoExtension : IExtension
{
    /// <summary>The most a case of a suite tagged slow may take.</summary>
    public const long SlowCeilingSec = 10;

    /// <summary>What one run of the extension hands its action.</summary>
    private sealed record EchoState(string Region);

    public string Name => "example";

    public IReadOnlyList<ActionRegistration> Actions { get; } = [new ActionRegistration("example.echo", Echo)];

    public IReadOnlyList<string> ContextKeys { get; } = ["region"];

    public IReadOnlyList<ExtensionOption> Options { get; } =
        [new ExtensionOption("--region", "The region ${region} reads, and example.echo prefixes.")];

    public ExtensionRules Rules { get; } = new() { Lint = Lint, CaseLimitSec = CaseLimit };

    public RunState Start(IReadOnlyDictionary<string, string> options)
    {
        var region = options.TryGetValue("--region", out var given) ? given : string.Empty;
        return new RunState
        {
            Context = new Dictionary<string, object?>(StringComparer.Ordinal) { ["region"] = region },
            State = new EchoState(region),
        };
    }

    private static bool IsSlow(OrderedMap suite) => (suite.List("tags") ?? []).Contains("slow");

    /// <summary>example.echo: returns {echoed: "&lt;region&gt;:&lt;text&gt;"}.</summary>
    private static object? Echo(ActionRequest request)
    {
        if (request.Step.Value("text") is not string text)
        {
            throw ActionException.Failed("example.echo needs a text.");
        }
        var region = (request.State as EchoState)?.Region ?? string.Empty;
        var out_ = new OrderedMap();
        out_.Set("echoed", region + ":" + text);
        return out_;
    }

    /// <summary>The ceiling at lint time: a case of a slow suite that declares
    /// more than the ceiling is E205, at the value, like the core's
    /// limits.</summary>
    private static IEnumerable<Diagnostic> Lint(RuleInput input)
    {
        if (!IsSlow(input.Suite))
        {
            yield break;
        }
        var tests = input.Suite.List("tests") ?? [];
        for (var index = 0; index < tests.Count; index++)
        {
            if (tests[index] is not OrderedMap held || held.Value("timeoutSec") is not long declared
                || declared <= SlowCeilingSec)
            {
                continue;
            }
            yield return Diagnostic.Error("E205", input.File,
                input.Document.At(string.Create(CultureInfo.InvariantCulture, $"/tests/{index}/timeoutSec")).Value,
                string.Create(CultureInfo.InvariantCulture,
                    $"Case {held.Text("name")} declares {declared} seconds; a suite tagged slow keeps each case within {SlowCeilingSec}."));
        }
    }

    /// <summary>The ceiling at run time: whatever a slow suite's case declares,
    /// it runs within the ceiling.</summary>
    private static long CaseLimit(OrderedMap suite, long declaredSec) =>
        IsSlow(suite) ? Math.Min(declaredSec, SlowCeilingSec) : declaredSec;
}
