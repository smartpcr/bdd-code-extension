using System.Globalization;
using Bdd.Suite.Actions;
using Bdd.Suite.Execution;
using Bdd.Suite.Extensions;
using Bdd.Suite.Model;
using Bdd.Suite.Schema;
using Bdd.Suite.Tracing;
using Bdd.Suite.Values;

namespace Bdd.Suite.Tests;

/// <summary>
/// The session (spec/session.md): a suite run a phase at a time, as a test
/// framework drives it. E1 for C# (docs/test-providers/design.md): every
/// execute corpus entry, driven through the session in a framework's call
/// order, emits the expected trace, in file order and with the cases reversed.
/// Then one test per rule.
/// </summary>
public sealed class SessionTests
{
    private static readonly SuiteSchema CorpusSchema = SuiteSchema.Load(Corpus.Find().SchemaRoot);

    private static string Line(OrderedMap entry) => string.Create(CultureInfo.InvariantCulture,
        $"{entry.Text("phase")} | {entry.Text("case")} | {entry.Text("step")} | {entry.Text("action")} | {entry.Text("status")} | {entry.Text("reason")}");

    private static List<string> Lines(IEnumerable<object?> trace) => trace.OfType<OrderedMap>().Select(Line).ToList();

    private static RunOptions OptionsOf(OrderedMap entry) => new()
    {
        Tags = entry.Text("tags").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
        Params = entry.Map("params") is { } given
            ? given.Keys.Select(key => new KeyValuePair<string, string>(key, Value.Text(given.Value(key)))).ToList()
            : [],
    };

    /// <summary>Drive one file as a framework does: the class hook's setup, then
    /// each case in the given order, then the class hook's teardown.</summary>
    private static (List<string> Trace, List<CaseResult> Results) Drive(string path, RunOptions options, bool reversed)
    {
        var suite = SuiteDocument.Load(File.ReadAllText(path)).Value as OrderedMap ?? throw new IOException(path);
        var context = RunContext.ForRun(options, Where.CorpusRun(), new Trace());
        var session = SuiteSession.Open(path, suite, CorpusSchema, context);
        session.Setup();
        var order = Enumerable.Range(0, session.Cases.Count).ToList();
        if (reversed)
        {
            order.Reverse();
        }
        var results = new List<CaseResult>();
        foreach (var index in order)
        {
            session.BeforeEach(index);
            session.RunCase(index);
            results.Add(session.AfterEach(index));
        }
        session.Teardown();
        return (Lines(context.Trace.ToList()), results);
    }

    /// <summary>The expected trace with its per-case groups in reverse order:
    /// the suite setup's entries first, the teardown's last, and each case's
    /// entries (which name it) kept together.</summary>
    private static List<string> CasesReversed(List<object?> expected)
    {
        var entries = expected.OfType<OrderedMap>().ToList();
        var setup = entries.TakeWhile(entry => entry.Text("phase") == Phase.SuiteSetup).ToList();
        var teardown = entries.Where(entry => entry.Text("phase") == Phase.SuiteTeardown).ToList();
        var groups = new List<List<OrderedMap>>();
        foreach (var entry in entries.Skip(setup.Count).Where(entry => entry.Text("phase") != Phase.SuiteTeardown))
        {
            if (groups.Count == 0 || groups[^1][0].Text("case") != entry.Text("case"))
            {
                groups.Add([]);
            }
            groups[^1].Add(entry);
        }
        groups.Reverse();
        return setup.Concat(groups.SelectMany(group => group)).Concat(teardown).Select(Line).ToList();
    }

    [Fact]
    public void E1EveryExecuteEntryThroughTheSessionInFileOrderAndReversed()
    {
        var corpus = Corpus.Find();
        var failures = new List<string>();
        var checked_ = 0;
        foreach (var entry in Corpus.Entries(corpus.Manifest(), "execute").Where(entry => !Corpus.PendingIn(entry, "csharp")))
        {
            var name = entry.Text("suite");
            var expected = corpus.Json(entry.Text("expectation")).List("trace") ?? [];
            var options = OptionsOf(entry);

            var (inOrder, results) = Drive(corpus.Path(name), options, reversed: false);
            if (!inOrder.SequenceEqual(Lines(expected)))
            {
                failures.Add($"{name} (file order):\n  {string.Join("\n  ", inOrder)}");
            }
            var (reversedTrace, _) = Drive(corpus.Path(name), options, reversed: true);
            if (!reversedTrace.SequenceEqual(CasesReversed(expected)))
            {
                failures.Add($"{name} (reversed):\n  {string.Join("\n  ", reversedTrace)}");
            }

            // The same results the whole-file run reports, case by case.
            var suite = corpus.Yaml(name);
            var whole = Executor.RunFile(corpus.Path(name), suite, CorpusSchema, options, new Trace(), Where.CorpusRun());
            var wholeCases = whole.Cases.Where(held => held.Name != "teardown")
                .Select(held => $"{held.Name}|{held.Status}|{held.Message}").ToList();
            var sessionCases = results.Select(held => $"{held.Name}|{held.Status}|{held.Message}").ToList();
            if (!wholeCases.SequenceEqual(sessionCases))
            {
                failures.Add($"{name} results differ from the whole-file run:\n  {string.Join("\n  ", sessionCases)}");
            }
            checked_++;
        }
        Assert.Equal(14, checked_);
        Assert.True(failures.Count == 0, string.Join('\n', failures));
    }

    // ------------------------------------------------------------------ rules

    private static SuiteSession OpenYaml(string yaml, RunContext? context = null, bool guarded = false)
    {
        var path = Path.Combine(Path.GetTempPath(), "session-" + Guid.NewGuid().ToString("N") + ".yml");
        File.WriteAllText(path, yaml);
        var suite = SuiteDocument.Load(yaml).Value as OrderedMap ?? throw new IOException(path);
        return SuiteSession.Open(path, suite, CorpusSchema,
            context ?? RunContext.ForRun(new RunOptions(), Where.CorpusRun(), new Trace()), guarded);
    }

    private static List<string> Phases(SuiteSession session) =>
        session.Trace.Entries.Select(entry => $"{entry.Phase}:{entry.Case}:{entry.Status}").ToList();

    private const string Hooks = """
        suite: hooks
        setup:
          - action: core.record
            marker: s
        beforeEach:
          - action: core.record
            marker: b
        afterEach:
          - action: core.record
            marker: a
        teardown:
          - action: core.record
            marker: t
        tests:
          - name: one
            tags: [first]
            steps:
              - then: it runs
                action: core.noop
          - name: two
            tags: [second]
            steps:
              - then: it runs too
                action: core.noop
        """;

    [Fact]
    public void Rule2SetupRunsOnceHoweverOftenItIsCalled()
    {
        var session = OpenYaml(Hooks);
        session.Setup();
        session.Setup();
        session.BeforeEach("one");
        session.RunCase("one");
        session.AfterEach("one");
        Assert.Single(session.Trace.Entries, entry => entry.Phase == Phase.SuiteSetup);
    }

    [Fact]
    public void Rule2NothingSelectedRunsNeitherSetupNorTeardown()
    {
        var context = RunContext.ForRun(new RunOptions { Tags = ["nobody"] }, Where.CorpusRun(), new Trace());
        var session = OpenYaml(Hooks, context);
        session.Setup();
        session.BeforeEach("one");
        var result = session.RunCase("one");
        session.AfterEach("one");
        Assert.Equal(Status.Skipped, result.Status);
        Assert.Equal(Reason.Tag, result.Reason);
        Assert.False(session.Teardown().Ran);
        Assert.Equal(["case:one:skipped"], Phases(session));
    }

    [Fact]
    public void Rule2BeforeEachRunsTheSetupWhenNoClassHookDid()
    {
        var session = OpenYaml(Hooks);
        session.BeforeEach("two");
        session.RunCase("two");
        session.AfterEach("two");
        Assert.True(session.Teardown().Ran);
        Assert.Equal(
            ["suite-setup::passed", "before-each:two:passed", "step:two:passed", "after-each:two:passed", "case:two:passed", "suite-teardown::passed"],
            Phases(session));
    }

    [Fact]
    public void Rule3AFailedSetupIsRecordedAndEveryCaseReportsIt()
    {
        var session = OpenYaml(Hooks.Replace("marker: s", "marker: s\n  - action: core.fail\n    message: no precondition", StringComparison.Ordinal));
        session.Setup();
        session.BeforeEach("one");
        var result = session.RunCase("one");
        var settled = session.AfterEach("one");
        Assert.Equal(Status.Error, settled.Status);
        Assert.Equal(Reason.SuiteSetup, result.Reason);
        Assert.StartsWith("Suite setup failed: ", settled.Message, StringComparison.Ordinal);
        Assert.True(session.Teardown().Ran);
        Assert.DoesNotContain(session.Trace.Entries, entry => entry.Phase == Phase.BeforeEach);
    }

    [Fact]
    public void Rule3AFailedBeforeEachIsRecordedAndTheCaseStillCleansUp()
    {
        var yaml = Hooks.Replace("marker: b", "marker: b\n  - action: core.fail\n    message: not ready", StringComparison.Ordinal)
            .Replace("    steps:\n      - then: it runs\n        action: core.noop",
                "    steps:\n      - then: it runs\n        action: core.noop\n    cleanup:\n      - action: core.record\n        marker: c", StringComparison.Ordinal);
        var session = OpenYaml(yaml);
        session.BeforeEach("one");
        var result = session.RunCase("one");
        var settled = session.AfterEach("one");
        Assert.Equal(Status.Failed, result.Status);
        Assert.Equal(Reason.Hook, settled.Reason);
        Assert.False(settled.AfterEachFailed);
        var phases = Phases(session);
        Assert.DoesNotContain("step:one:passed", phases);
        Assert.Contains("case-cleanup:one:passed", phases);
        Assert.Contains("after-each:one:passed", phases);
        Assert.Equal("case:one:failed", phases[^1]);
    }

    [Fact]
    public void Rule4AFailedAfterEachSettlesTheCaseAndSaysSo()
    {
        var session = OpenYaml(Hooks.Replace("marker: a", "marker: a\n  - action: core.fail\n    message: could not tidy", StringComparison.Ordinal));
        session.BeforeEach("one");
        Assert.Equal(Status.Passed, session.RunCase("one").Status);
        var settled = session.AfterEach("one");
        Assert.True(settled.AfterEachFailed);
        Assert.Equal(Status.Failed, settled.Status);
        Assert.Equal(Reason.Hook, settled.Reason);
        Assert.Contains("afterEach failed:", settled.Message, StringComparison.Ordinal);
        Assert.Equal("case:one:failed", Phases(session)[^1]);
    }

    [Fact]
    public void Rule4AnAfterEachWithoutTheCaseStillCleansUpAndFails()
    {
        var session = OpenYaml(Hooks);
        session.BeforeEach("one");
        var settled = session.AfterEach("one");
        Assert.Equal(Status.Failed, settled.Status);
        Assert.Contains("not the case itself", settled.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Rule1OperationsOutOfOrderAreRefused()
    {
        var session = OpenYaml(Hooks);
        Assert.Throws<InvalidOperationException>(() => session.RunCase("one"));
        Assert.Throws<InvalidOperationException>(() => session.AfterEach("one"));
        session.BeforeEach("one");
        session.RunCase("one");
        Assert.Throws<InvalidOperationException>(() => session.RunCase("one"));
        session.AfterEach("one");
        Assert.Throws<InvalidOperationException>(() => session.AfterEach("one"));
        Assert.Throws<ArgumentException>(() => session.BeforeEach("three"));
    }

    [Fact]
    public void Rule5ACaseStartsFromADeepCopyOfTheSetupBag()
    {
        var original = SuiteDocument.Load("a:\n  b: [1]\n").Value as OrderedMap ?? throw new IOException();
        var copy = original.DeepClone();
        (copy.Map("a")!.List("b")!).Add(2L);
        Assert.Single(original.Map("a")!.List("b")!);
    }

    [Fact]
    public void Rule6TeardownRunsOnceAndOnlyAfterASetup()
    {
        var session = OpenYaml(Hooks);
        Assert.False(session.Teardown().Ran);
        session.Setup();
        Assert.True(session.Teardown().Ran);
        Assert.False(session.Teardown().Ran);
        Assert.Single(session.Trace.Entries, entry => entry.Phase == Phase.SuiteTeardown);
    }

    [Fact]
    public void Rule6AFailedTeardownIsReturnedNotThrown()
    {
        var session = OpenYaml(Hooks.Replace("marker: t", "marker: t\n  - action: core.fail\n    message: could not undo", StringComparison.Ordinal));
        session.Setup();
        var teardown = session.Teardown();
        Assert.True(teardown.Failed);
        Assert.Contains("could not undo", teardown.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Rule7OneCaseOfASessionRunsAtATime()
    {
        var session = OpenYaml(Hooks);
        session.BeforeEach("one");
        var second = Task.Run(() =>
        {
            session.BeforeEach("two");
            session.RunCase("two");
            return session.AfterEach("two");
        });
        // The second case cannot start while the first holds the case lock.
        await Task.Delay(300);
        Assert.False(second.IsCompleted);
        session.RunCase("one");
        session.AfterEach("one");
        Assert.Equal(Status.Passed, (await second).Status);
        var phases = Phases(session);
        Assert.True(phases.IndexOf("case:one:passed") < phases.IndexOf("before-each:two:passed"));
    }

    [Fact]
    public void Rule9AGuardedSuiteSkipsUnlessTheRunAllowsIt()
    {
        var refusing = RunContext.Create(new RunOptions(), Where.CorpusComposite, allowGuarded: false);
        var session = OpenYaml(Hooks, refusing, guarded: true);
        session.Setup();
        session.BeforeEach("one");
        var result = session.RunCase("one");
        session.AfterEach("one");
        Assert.Equal(Status.Skipped, result.Status);
        Assert.Equal(SuiteSession.GuardedMessage, result.Message);
        Assert.False(session.Teardown().Ran);
        Assert.Equal(["case:one:skipped"], Phases(session));
        Assert.Equal(Reason.Guard, session.Trace.Entries[0].Reason);

        var allowing = RunContext.Create(new RunOptions(), Where.CorpusComposite, allowGuarded: true);
        var allowed = OpenYaml(Hooks, allowing, guarded: true);
        allowed.BeforeEach("one");
        Assert.Equal(Status.Passed, allowed.RunCase("one").Status);
        allowed.AfterEach("one");
    }

    [Fact]
    public void ADryRunValidatesAndTracesNothing()
    {
        var context = RunContext.ForRun(new RunOptions { DryRun = true }, Where.CorpusRun(), new Trace());
        var session = OpenYaml(Hooks, context);
        session.Setup();
        session.BeforeEach("one");
        session.RunCase("one");
        var settled = session.AfterEach("one");
        Assert.Equal(Status.Skipped, settled.Status);
        Assert.False(session.Teardown().Ran);
        Assert.Empty(session.Trace.Entries);
    }

    // ------------------------------------------------- the run context's inputs

    private static readonly Extension Lab = new()
    {
        Name = "lab",
        Options = [new ExtensionOption("--api-url", "the API"), new ExtensionOption("--lab-id", "the lab")],
        ContextKeys = ["apiUrl"],
        OnStart = given => new RunState
        {
            Context = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["apiUrl"] = given.TryGetValue("--api-url", out var url) ? url : "(none)",
            },
        },
    };

    [Fact]
    public void FromValuesReadsOptionsTagsAndSwitchesUnderThePrefix()
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["BDD_SUITE_OPTION_API_URL"] = "https://lab/api",
            ["BDD_SUITE_TAGS"] = " smoke , slow ,",
            ["BDD_SUITE_DRY_RUN"] = "1",
            ["BDD_SUITE_ALLOW_GUARDED"] = "1",
            ["BDD_SUITE_TRACE_FILE"] = "out/trace.json",
            ["BDD_SUITE_RECORD_PATH"] = "out/record.txt",
        };
        var context = RunContext.FromValues(name => values.GetValueOrDefault(name), [Lab]);
        Assert.Equal("https://lab/api", context.Extensions.Started.Context["apiUrl"]);
        Assert.Equal(["smoke", "slow"], context.Options.Tags);
        Assert.True(context.Options.DryRun);
        Assert.True(context.AllowGuarded);
        Assert.Equal("out/trace.json", context.TraceFile);
        Assert.Equal("out/record.txt", context.Options.RecordPath);
    }

    [Fact]
    public void FromValuesDefaultsToNothingAllowedAndUsesTheExtensionsPrefix()
    {
        var prefixed = new Extension { Name = "prefixed", EnvPrefix = "SHOP_", Options = [new ExtensionOption("--region", "x")] };
        var values = new Dictionary<string, string>(StringComparer.Ordinal) { ["SHOP_OPTION_REGION"] = "eu", ["BDD_SUITE_ALLOW_GUARDED"] = "1" };
        var context = RunContext.FromValues(name => values.GetValueOrDefault(name), [prefixed]);
        Assert.False(context.AllowGuarded);
        Assert.False(context.Options.DryRun);
        Assert.Empty(context.Options.Tags);
        Assert.Equal(string.Empty, context.TraceFile);
        Assert.Equal("REGION", RunContext.OptionVariable("--region"));
        Assert.Equal("API_URL", RunContext.OptionVariable("--api-url"));
    }

    [Fact]
    public void WriteTraceWritesTheTraceWhereTheRunContextSays()
    {
        var file = Path.Combine(Path.GetTempPath(), "session-trace-" + Guid.NewGuid().ToString("N"), "trace.json");
        var context = RunContext.Create(new RunOptions(), traceFile: file);
        var session = OpenYaml(Hooks, context);
        session.BeforeEach("one");
        session.RunCase("one");
        session.AfterEach("one");
        context.WriteTrace();
        Assert.Contains("\"case\": \"one\"", File.ReadAllText(file), StringComparison.Ordinal);

        RunContext.Create(new RunOptions()).WriteTrace();
    }

    [Fact]
    public void OpenFileRefusesASuiteThatDoesNotLintClean()
    {
        var bad = Path.Combine(Path.GetTempPath(), "session-bad-" + Guid.NewGuid().ToString("N") + ".yml");
        File.WriteAllText(bad, "suite: bad\ntests:\n  - name: one\n    steps:\n      - then: it calls nothing real\n        action: core.nope\n");
        var refused = Assert.Throws<SuiteRefusedException>(() =>
            SuiteSession.OpenFile(bad, CorpusSchema, RunContext.Create(new RunOptions())));
        Assert.Contains(refused.Findings, finding => finding.Code == "E104");

        var good = Path.Combine(Path.GetTempPath(), "session-good-" + Guid.NewGuid().ToString("N") + ".yml");
        File.WriteAllText(good, Hooks);
        var session = SuiteSession.OpenFile(good, CorpusSchema, RunContext.Create(new RunOptions()));
        Assert.Equal(["one", "two"], session.Cases);
        Assert.True(session.IsSelected("two"));
    }

    [Fact]
    public void TheTraceTakesEntriesFromManyThreads()
    {
        var trace = new Trace();
        Parallel.For(0, 1000, index => trace.Add(Phase.Step, "c" + index, "s", "core.noop", Status.Passed, Reason.None));
        Assert.Equal(1000, trace.Entries.Count);
    }
}
