using Bdd.Suite.Execution;

namespace Bdd.Suite.Testing;

/// <summary>
/// One suite's session as a generated test class drives it: the class hooks
/// call <see cref="Setup"/> and <see cref="Teardown"/>, the per-test hooks
/// <see cref="BeforeEach"/> and <see cref="AfterEach"/> with the running test's
/// method name, and each test <see cref="Run"/> with its case's exact name.
/// Results come back as they are (spec/session.md); the generated provider glue
/// turns them into the framework's verdicts.
/// </summary>
public sealed class SuiteTests
{
    private readonly Dictionary<string, string> _caseOf = new(StringComparer.Ordinal);

    public SuiteTests(SuiteSession session, IEnumerable<(string Method, string Case)> cases)
    {
        Session = session;
        foreach (var (method, name) in cases)
        {
            _caseOf[method] = name;
        }
    }

    public SuiteSession Session { get; }

    /// <summary>The case a test method runs.</summary>
    public string CaseOf(string method) => _caseOf.TryGetValue(method, out var name)
        ? name
        : throw new ArgumentException($"{Session.Name} has no test method {method}; generate the tests again.", nameof(method));

    public void Setup() => Session.Setup();

    public void BeforeEach(string method) => Session.BeforeEach(CaseOf(method));

    public CaseResult Run(string caseName) => Session.RunCase(caseName);

    public CaseResult AfterEach(string method) => Session.AfterEach(CaseOf(method));

    public TeardownResult Teardown() => Session.Teardown();
}
