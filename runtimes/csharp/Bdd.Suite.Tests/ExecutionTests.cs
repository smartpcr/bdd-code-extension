using System.Globalization;
using System.Text;
using Bdd.Suite.Actions;
using Bdd.Suite.Execution;
using Bdd.Suite.Extensions;
using Bdd.Suite.Model;
using Bdd.Suite.Reporting;
using Bdd.Suite.Schema;
using Bdd.Suite.Tracing;
using Bdd.Suite.Walking;

namespace Bdd.Suite.Tests;

/// <summary>
/// The execute corpus in conformance is what says this executor behaves
/// the way the other runtimes do. What is here is the rest: the pieces a shared
/// corpus cannot reach, and the ones about C# rather than about the format.
/// </summary>
public sealed class ExecutionTests
{
    private static OrderedMap Parse(string text) =>
        SuiteDocument.Load(text).Value as OrderedMap
        ?? throw new InvalidOperationException("the text does not hold a mapping");

    private static SuiteSchema Committed() => SuiteSchema.Load(Corpus.Find().SchemaRoot);

    /// <summary>A suite file path inside the corpus folder, for a suite that is
    /// given as text and never read from it.</summary>
    private static string Probe() => Corpus.Find().Path("probe.yml");

    private static CaseContext BagWith(string text)
    {
        var scope = new OrderedMap();
        scope.Set("capture", SuiteDocument.Load(text).Value);
        return new CaseContext { Scope = scope };
    }

    [Fact]
    public void ASubjectWalksIntoTheBagAndSaysWhetherItWasThere()
    {
        var context = BagWith("cs:\n  State: Up\n  Nodes: [N1, N2]\nnothing:\n");
        var rows = new (string Path, object? Want, bool Present)[]
        {
            ("cs.State", "Up", true),
            ("cs.Nodes.1", "N2", true),
            ("cs.Nodes.9", null, false),
            ("cs.Missing", null, false),
            ("nothing", null, true),
            ("nothing.deeper", null, false),
        };
        foreach (var (path, want, present) in rows)
        {
            var (value, found) = Executor.Actual(path, context);
            Assert.Equal(present, found);
            if (present)
            {
                Assert.Equal(want, value);
            }
        }
        Assert.False(Executor.Actual("anything", new CaseContext { Scope = new OrderedMap() }).Present);
    }

    [Fact]
    public void AScriptAssertionIsRefusedRatherThanPassed()
    {
        var context = BagWith("cs:\n  State: Up\n");
        var assertion = new OrderedMap();
        assertion.Set("script", "$true");
        var refused = Assert.Throws<ActionException>(() => Executor.CheckAssertion(assertion, context));
        Assert.Contains("PowerShell binding only", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AnAssertionComparesEveryOperatorItCarries()
    {
        var context = BagWith("cs:\n  State: Up\n  Count: 3\n");
        var passing = new OrderedMap();
        passing.Set("var", "cs.State");
        passing.Set("equals", "Up");
        passing.Set("notEquals", "Down");
        Executor.CheckAssertion(passing, context);

        var failing = new OrderedMap();
        failing.Set("var", "cs.State");
        failing.Set("equals", "Down");
        var refused = Assert.Throws<ActionException>(() => Executor.CheckAssertion(failing, context));
        Assert.Contains("expected cs.State equals 'Down'", refused.Message, StringComparison.Ordinal);

        var uncomparable = new OrderedMap();
        uncomparable.Set("var", "cs.State");
        uncomparable.Set("gt", "x");
        Assert.Throws<ActionException>(() => Executor.CheckAssertion(uncomparable, context));

        // Something that is not a mapping is nothing to assert, not a failure.
        Executor.CheckAssertion("not an assertion", context);

        var broken = new OrderedMap();
        broken.Set("var", "cs.State");
        broken.Set("equals", "${nosuch.thing}");
        Assert.Throws<ActionException>(() => Executor.CheckAssertion(broken, context));
    }

    /// <summary>A test extension with one action that ignores its deadline,
    /// which is what proves the executor abandons one rather than waiting it
    /// out.</summary>
    private static (RunExtensions Run, ManualResetEventSlim Finished) SlowExtension()
    {
        var finished = new ManualResetEventSlim(false);
        var extension = new Extension
        {
            Name = "fixture",
            Actions =
            [
                new ActionRegistration("fixture.slow", _ =>
                {
                    Thread.Sleep(TimeSpan.FromSeconds(4));
                    finished.Set();
                    return "too late";
                }),
            ],
        };
        var composite = Composite.Compose(extension);
        return (new RunExtensions(composite, composite.Start(new Dictionary<string, string>())), finished);
    }

    [Fact]
    public void AnActionThatIgnoresItsDeadlineIsAbandoned()
    {
        var (run, finished) = SlowExtension();
        var context = new CaseContext { Scope = new OrderedMap(), Run = run };
        var started = DateTime.UtcNow;
        var refused = Assert.Throws<ActionException>(() =>
            Executor.Bounded("fixture.slow", new OrderedMap(), context, 1, "the step", false));
        Assert.Contains("abandoned", refused.Message, StringComparison.Ordinal);
        Assert.True(DateTime.UtcNow - started < TimeSpan.FromSeconds(4), "it waited the limit out");
        Assert.True(finished.Wait(TimeSpan.FromSeconds(8)), "the abandoned action never finished");
    }

    [Fact]
    public void AnExtensionsActionSeesItsOwnStateAndACoreActionNone()
    {
        object? seen = "unset";
        var extension = new Extension
        {
            Name = "fixture",
            Actions = [new ActionRegistration("fixture.get", request => seen = request.State)],
            OnStart = _ => new RunState { State = "mine" },
        };
        var composite = Composite.Compose(extension);
        var context = new CaseContext
        {
            Scope = new OrderedMap(),
            Run = new RunExtensions(composite, composite.Start(new Dictionary<string, string>())),
        };
        Executor.Bounded("fixture.get", new OrderedMap(), context, 5, "the step", true);
        Assert.Equal("mine", seen);
        Assert.Null(context.Run.Started.State(-1));
        Assert.Null(context.Run.Started.State(7));
    }

    [Fact]
    public void AnInterruptibleActionSaysItWasCancelled()
    {
        var context = new CaseContext { Scope = new OrderedMap() };
        var step = new OrderedMap();
        step.Set("seconds", 30L);
        var refused = Assert.Throws<ActionException>(() =>
            Executor.Bounded("core.sleep", step, context, 1, "the step", true));
        Assert.DoesNotContain("abandoned", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AnActionNobodyImplementsIsNamedRatherThanGuessed()
    {
        var context = new CaseContext { Scope = new OrderedMap() };
        Assert.Equal("Unknown action: nosuch.action. No extension of this runtime registers it.",
            Assert.Throws<ActionException>(() =>
                Executor.Bounded("nosuch.action", new OrderedMap(), context, 5, "the step", true)).Message);
        // No action is special by its prefix any more: an action the catalog
        // declares and no extension registers is unknown in the same words.
        Assert.Equal("Unknown action: fixture.state. No extension of this runtime registers it.",
            Assert.Throws<ActionException>(() =>
                Executor.Bounded("fixture.state", new OrderedMap(), context, 5, "the step", true)).Message);
        // wait is the core's, run by the executor itself, never dispatched.
        Assert.Contains("Unknown action: wait",
            Assert.Throws<ActionException>(() =>
                Executor.Bounded("wait", new OrderedMap(), context, 5, "the step", true)).Message,
            StringComparison.Ordinal);
        // A limit that has already run out is a timeout before anything runs.
        var expired = Assert.Throws<ActionException>(() =>
            Executor.Bounded("core.noop", new OrderedMap(), context, 0, "the step", true));
        Assert.Contains("no time left", expired.Message, StringComparison.Ordinal);
        Assert.Equal(Reason.Timeout, expired.Reason);
    }

    [Fact]
    public void ARecordPathReachesTheActionThatWritesIt()
    {
        var path = Path.Combine(Path.GetTempPath(), "suiterun-markers-" + Guid.NewGuid().ToString("N") + ".txt");
        try
        {
            var context = new CaseContext { Scope = new OrderedMap(), RecordPath = path };
            var step = new OrderedMap();
            step.Set("marker", "here");
            Executor.Bounded("core.record", step, context, 5, "the step", true);
            Assert.Equal("here", File.ReadAllText(path).Trim());
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void AllNamesIsTheCoreActionsWaitAndEveryExtensionsActions()
    {
        var core = Executor.AllNames();
        Assert.Equal(7, core.Count);
        Assert.Equal("wait", core[^1]);
        var full = Executor.AllNames(SlowExtension().Run.Composite);
        Assert.Equal(8, full.Count);
        Assert.Contains("fixture.slow", full);
        Assert.Equal(full.OrderBy(name => name, StringComparer.Ordinal), full);
    }

    [Fact]
    public void ARunThatFailedIsWhatDecidesTheExitCode()
    {
        Assert.False(Executor.Failed([Suite(Status.Passed)]));
        Assert.False(Executor.Failed([Suite(Status.Skipped)]));
        Assert.True(Executor.Failed([Suite(Status.Failed)]));
        Assert.True(Executor.Failed([Suite(Status.Error)]));
        Assert.False(Executor.Failed([]));

        static SuiteResult Suite(string status)
        {
            var result = new SuiteResult { Name = "s" };
            result.Cases.Add(new CaseResult { Name = "c", Status = status });
            return result;
        }
    }

    [Fact]
    public void AMetaStepBecomesTheStepsItStandsFor()
    {
        var definitions = SuiteExpansion.MetaDefinitions(Parse("""
            metaSteps:
              - name: mark
                params:
                  - { name: label, default: unnamed }
                steps:
                  - given: the marker of ${param.label}
                    action: core.record
                    marker: ${param.label}-one
                  - given: the second of ${param.label}
                    action: core.record
                    marker: ${param.label}-two
            """), new RunLibrary());

        var chosen = SuiteExpansion.ExpandSteps(
            Parse("steps:\n  - meta: mark\n    with: { label: chosen }\n").List("steps"),
            definitions, "case c", 0, string.Empty);
        Assert.Equal(2, chosen.Count);
        Assert.Equal("chosen-one", chosen[0].Text("marker"));
        Assert.Equal("meta mark step 1", chosen[0].Text("__provenance"));
        Assert.Equal("given", chosen[0].Text("__keyword"));
        Assert.StartsWith("given the marker of chosen (core.record)",
            SuiteExpansion.StepLabel(chosen[0]), StringComparison.Ordinal);

        var defaulted = SuiteExpansion.ExpandSteps(
            Parse("steps:\n  - meta: mark\n").List("steps"), definitions, "case c", 0, string.Empty);
        Assert.Equal("unnamed-one", defaulted[0].Text("marker"));

        var guarded = SuiteExpansion.ExpandSteps(
            Parse("steps:\n  - meta: mark\n    ifCapture: held\n").List("steps"),
            definitions, "case c", 0, string.Empty);
        Assert.All(guarded, step => Assert.Equal("held", step.Text("ifCapture")));

        var missing = Assert.Throws<ExpansionException>(() => SuiteExpansion.ExpandSteps(
            Parse("steps:\n  - meta: nosuch\n").List("steps"), definitions, "case c", 0, string.Empty));
        Assert.Contains("nosuch", missing.Message, StringComparison.Ordinal);
        Assert.Contains("case c step 1", missing.Message, StringComparison.Ordinal);

        var cyclic = SuiteExpansion.MetaDefinitions(
            Parse("metaSteps:\n  - name: a\n    steps:\n      - meta: a\n"), new RunLibrary());
        var refused = Assert.Throws<ExpansionException>(() => SuiteExpansion.ExpandSteps(
            Parse("steps:\n  - meta: a\n").List("steps"), cyclic, "case c", 0, string.Empty));
        Assert.Contains("cycle", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ATableBecomesOneStepPerRowAndAnAndContinuesTheKeywordBeforeIt()
    {
        var rows = SuiteExpansion.ExpandSteps(Parse("""
            steps:
              - when: each node is recorded
                action: core.record
                marker: ${row.node}
                table:
                  - { node: N1 }
                  - { node: N2 }
            """).List("steps"), [], "case c", 0, string.Empty);
        Assert.Equal(2, rows.Count);
        Assert.Equal(1L, rows[0].Value("__rowIndex"));
        Assert.Equal(2L, rows[1].Value("__rowIndex"));
        Assert.Equal(2L, rows[0].Value("__rowCount"));
        Assert.False(rows[0].Has("table"));
        Assert.Contains("row 2 (node=N2)", SuiteExpansion.StepLabel(rows[1]), StringComparison.Ordinal);

        var scenario = SuiteExpansion.ExpandSteps(Parse("""
            steps:
              - given: a group
                action: core.noop
              - and: another thing
                action: core.noop
              - when: it moves
                action: core.noop
              - and: it settles
                action: core.noop
            """).List("steps"), [], "case c", 0, string.Empty);
        Assert.Equal(["given", "given", "when", "when"], scenario.Select(step => step.Text("__keyword")));
        Assert.Equal("another thing", scenario[1].Text("__sentence"));

        var lonely = SuiteExpansion.ExpandSteps(
            Parse("steps:\n  - and: alone\n    action: core.noop\n").List("steps"),
            [], "case c", 0, string.Empty);
        Assert.Equal("and", lonely[0].Text("__keyword"));
    }

    [Fact]
    public void AnOutlineBecomesOneCasePerRowNamedByIt()
    {
        var held = Parse("name: c\nexamples:\n  - { node: N1 }\n  - { node: N2 }\nsteps: []\n");
        var expanded = SuiteExpansion.ExpandOutline(held);
        Assert.Equal(2, expanded.Count);
        Assert.Equal("c [node=N1]", expanded[0].Text("name"));
        Assert.Equal("N2", (expanded[1].Value("__row") as OrderedMap)!.Value("node"));
        Assert.False(expanded[0].Has("examples"));
        Assert.Single(SuiteExpansion.ExpandOutline(Parse("name: c\n")));
        Assert.Single(SuiteExpansion.ExpandOutline(Parse("name: c\nexamples: []\n")));
        Assert.Equal(string.Empty, SuiteExpansion.FormatRow(null));
    }

    [Fact]
    public void AParameterTakesTheValueOfTheHighestLevelThatNamesIt()
    {
        var library = new RunLibrary();
        library.Params.Add(Parse("name: shared\ndefault: library\n"));
        var suite = Parse("params:\n  - { name: shared, default: file }\n  - { name: fromFile, default: file }\n");
        var held = Parse("params:\n  - { name: shared, value: case }\n");
        var values = SuiteExpansion.ResolveParams(library, suite, held,
            [new KeyValuePair<string, string>("fromFile", "command line")]);
        Assert.Equal("case", values.Value("shared"));
        Assert.Equal("command line", values.Value("fromFile"));

        // BDD_SUITE_ by default; an extension may name another prefix.
        Environment.SetEnvironmentVariable("BDD_SUITE_PARAM_FROMFILE", "from the environment");
        Environment.SetEnvironmentVariable("OTHER_PARAM_FROMFILE", "from another prefix");
        try
        {
            var withEnvironment = SuiteExpansion.ResolveParams(library, suite, null, []);
            Assert.Equal("from the environment", withEnvironment.Value("fromFile"));
            var withPrefix = SuiteExpansion.ResolveParams(library, suite, null, [], "OTHER_");
            Assert.Equal("from another prefix", withPrefix.Value("fromFile"));
        }
        finally
        {
            Environment.SetEnvironmentVariable("BDD_SUITE_PARAM_FROMFILE", null);
            Environment.SetEnvironmentVariable("OTHER_PARAM_FROMFILE", null);
        }
    }

    [Fact]
    public void VariablesAreEvaluatedAgainstWhatIsAlreadyInScope()
    {
        var suite = Parse("vars:\n  region: west\n  greeting: hello ${var.region}\n");
        var scope = new OrderedMap();
        scope.Set("var", new OrderedMap());
        SuiteExpansion.ResolveVars(new RunLibrary(), suite, null, scope);
        Assert.Equal("hello west", scope.Map("var")!.Value("greeting"));

        var held = Parse("vars:\n  full: ${var.greeting} again\n");
        SuiteExpansion.ResolveVars(new RunLibrary(), suite, held, scope);
        Assert.Equal("hello west again", scope.Map("var")!.Value("full"));
    }

    [Fact]
    public void ALimitMayShortenAndNeverLengthenAndATagFilterSelectsByAnyMatch()
    {
        Assert.Equal(120, SuiteExpansion.StepLimit(0, 120));
        Assert.Equal(30, SuiteExpansion.StepLimit(30, 120));
        Assert.Equal(120, SuiteExpansion.StepLimit(300, 120));

        Assert.True(SuiteExpansion.TagsMatch(["a"], []));
        Assert.True(SuiteExpansion.TagsMatch(["a", "b"], ["b"]));
        Assert.False(SuiteExpansion.TagsMatch(["a"], ["b"]));
        Assert.Equal(["own", "suite"],
            SuiteExpansion.CaseTags(Parse("tags: [suite]\n"), Parse("tags: [own]\n")));
    }

    [Fact]
    public void AnImportThatIsNotThereOrFormsACycleIsRefused()
    {
        Assert.Throws<ExpansionException>(() =>
            SuiteExpansion.ReadLibraries(Parse("imports: [nosuchfile.yml]\n"), "suite.yml"));
        Assert.Throws<ExpansionException>(() =>
            SuiteExpansion.ReadLibraries(Parse("imports: [suite.yml]\n"), "suite.yml"));
    }

    [Fact]
    public void AStepWithNoSentenceIsNamedForItsAction()
    {
        Assert.Equal("step core.noop", SuiteExpansion.StepLabel(Parse("action: core.noop\n")));
        Assert.Equal("step 1 (core.noop)",
            SuiteExpansion.StepLabel(Parse("action: core.noop\n__provenance: step 1\n")));
    }

    [Fact]
    public void AWaitNeedsSomethingToDoAndGivesUpWhenItsUntilNeverHolds()
    {
        var schema = Committed();
        var suite = Parse("""
            tests:
              - name: c
                steps:
                  - action: wait
                  - action: wait
                    seconds: 0.01
                  - action: wait
                    intervalSec: 1
                    timeoutSec: 1
                    forStep:
                      action: core.set
                      value: still working
                      captureAs: state
                    until:
                      var: state
                      equals: done
            """);
        var trace = new Trace();
        var result = Executor.RunFile(Probe(), suite, schema, new RunOptions(), trace);
        Assert.Single(result.Cases);
        Assert.Equal(Status.Failed, result.Cases[0].Status);
        Assert.Contains("seconds, or a forStep", result.Cases[0].Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AnEntryCarriesOnlyWhatTheTraceContractNames()
    {
        var trace = new Trace();
        trace.Add(Phase.Step, "c", "when x (core.noop)", "core.noop", Status.Passed, Reason.None);
        trace.Add(Phase.Case, "c", string.Empty, string.Empty, Status.Failed, Reason.Assertion);
        var entries = trace.ToList().OfType<OrderedMap>().ToList();
        Assert.Equal("step", entries[0].Text("phase"));
        Assert.Equal("core.noop", entries[0].Text("action"));
        Assert.False(entries[0].Has("reason"));
        Assert.Equal("failed", entries[1].Text("status"));
        Assert.Equal("assertion", entries[1].Text("reason"));
        Assert.False(entries[1].Has("step"));

        var empty = new Trace();
        empty.Add(Phase.SuiteSetup, string.Empty, string.Empty, string.Empty, Status.Passed, Reason.None);
        foreach (var key in new[] { "case", "step", "action" })
        {
            Assert.False(empty.Entries[0].ToMap().Has(key));
        }
        Assert.Equal("[]", new Trace().ToJson());
        Assert.Contains("\"phase\": \"step\"", trace.ToJson(), StringComparison.Ordinal);
    }

    [Fact]
    public void ARunsReportCountsWhatHappened()
    {
        var suite = new SuiteResult { Name = "s.yml" };
        suite.Cases.Add(new CaseResult
        {
            Name = "passes", Status = Status.Passed, Output = "\"Up\"", DurationSec = 0.5,
        });
        suite.Cases.Add(new CaseResult
        {
            Name = "fails", Status = Status.Failed, Message = "expected x equals 'y', got 'z'", DurationSec = 0.25,
        });
        suite.Cases.Add(new CaseResult { Name = "skips", Status = Status.Skipped, Message = "tag filter" });
        var suites = new List<SuiteResult> { suite };

        var nunit = Reports.NUnit3(suites);
        foreach (var want in new[]
                 {
                     "total=\"3\"", "passed=\"1\"", "failed=\"1\"", "skipped=\"1\"", "result=\"Failed\"",
                     "<message>expected x equals &apos;y&apos;, got &apos;z&apos;</message>",
                     "<output>&quot;Up&quot;</output>", "<reason>",
                 })
        {
            Assert.Contains(want, nunit, StringComparison.Ordinal);
        }

        var junit = Reports.JUnit(suites);
        foreach (var want in new[]
                 {
                     "<testsuite name=\"s.yml\" tests=\"3\" failures=\"1\" skipped=\"1\">",
                     "<failure message=\"expected x equals &apos;y&apos;, got &apos;z&apos;\">",
                     "<skipped message=\"tag filter\">",
                     "<system-out>&quot;Up&quot;</system-out>",
                 })
        {
            Assert.Contains(want, junit, StringComparison.Ordinal);
        }

        Assert.Contains("total=\"0\"", Reports.NUnit3([]), StringComparison.Ordinal);
        Assert.Contains("<testsuites>", Reports.JUnit([]), StringComparison.Ordinal);
        Assert.Equal("a&amp;b&lt;c&gt;d&quot;e&apos;f", Reports.Escape("a&b<c>d\"e'f"));
    }

    [Fact]
    public void EveryCoreActionIsRegisteredAndDoesWhatItSays()
    {
        Assert.Equal(6, CoreActions.Names().Count);
        foreach (var name in new[] { "core.noop", "core.set", "core.fail", "core.skip", "core.sleep", "core.record" })
        {
            Assert.True(CoreActions.Registry.ContainsKey(name), name);
        }

        var context = new CaseContext { Scope = new OrderedMap() };
        var noop = Executor.Bounded("core.noop", new OrderedMap(), context, 5, "s", true) as OrderedMap;
        Assert.Equal(true, noop!.Value("ok"));

        var set = new OrderedMap();
        set.Set("value", "x");
        Assert.Equal("x", Executor.Bounded("core.set", set, context, 5, "s", true));
        Assert.Contains("value is required",
            Assert.Throws<ActionException>(() =>
                Executor.Bounded("core.set", new OrderedMap(), context, 5, "s", true)).Message,
            StringComparison.Ordinal);

        Assert.Contains("failed on purpose",
            Assert.Throws<ActionException>(() =>
                Executor.Bounded("core.fail", new OrderedMap(), context, 5, "s", true)).Message,
            StringComparison.Ordinal);

        var chosen = new OrderedMap();
        chosen.Set("message", "chosen");
        var picked = Assert.Throws<ActionException>(() =>
            Executor.Bounded("core.fail", chosen, context, 5, "s", true));
        Assert.Equal("chosen", picked.Message);
        Assert.Equal(Reason.Action, picked.Reason);

        var slept = new OrderedMap();
        slept.Set("seconds", 0.01);
        var rested = Executor.Bounded("core.sleep", slept, context, 5, "s", true) as OrderedMap;
        Assert.Equal(0.01, rested!.Value("sleptSec"));

        Assert.Contains("marker is required",
            Assert.Throws<ActionException>(() =>
                Executor.Bounded("core.record", new OrderedMap(), context, 5, "s", true)).Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ACaseCannotWriteIntoTheSuiteBag()
    {
        var schema = Committed();
        var suite = Parse("""
            setup:
              - action: core.set
                value: kept
                captureAs: fromSetup
            tests:
              - name: one
                steps:
                  - action: core.set
                    value: mine
                    captureAs: fromCase
                asserts:
                  - var: fromSetup
                    equals: kept
              - name: two
                steps:
                  - action: core.noop
                asserts:
                  - var: fromCase
                    isNull: true
            """);
        var trace = new Trace();
        var result = Executor.RunFile(Probe(), suite, schema, new RunOptions(), trace);
        Assert.All(result.Cases, held =>
            Assert.True(string.Equals(held.Status, Status.Passed, StringComparison.Ordinal),
                string.Create(CultureInfo.InvariantCulture, $"{held.Name}: {held.Message}")));
    }

    [Fact]
    public void TheWalkAndTheExpansionAgreeOnWhatAStepListHolds()
    {
        var suite = Parse("""
            setup:
              - action: core.noop
            teardown:
              - action: core.noop
            tests:
              - name: c
                steps:
                  - action: core.noop
            """);
        var hooks = SuiteExpansion.ExpandedHooks(suite, []);
        Assert.Single(hooks["setup"]);
        Assert.Single(hooks["teardown"]);
        Assert.Empty(hooks["beforeEach"]);
        var cases = SuiteExpansion.Cases(suite);
        Assert.Single(cases);
        var phases = SuiteExpansion.ExpandedCase(cases[0], []);
        Assert.Single(phases["steps"]);
        Assert.Empty(phases["cleanup"]);
        Assert.Equal(3, Walk.AllSteps(suite).Count);
        Assert.Equal(new StringBuilder().ToString(), string.Empty);
    }
}
