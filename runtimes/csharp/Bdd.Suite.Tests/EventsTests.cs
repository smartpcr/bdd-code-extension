using System.Text.Json.Nodes;
using Bdd.Suite.Actions;
using Bdd.Suite.Cli;
using Bdd.Suite.Execution;
using Bdd.Suite.Extensions;
using Bdd.Suite.Model;
using Bdd.Suite.Run;
using Bdd.Suite.Schema;
using Bdd.Suite.Tracing;

namespace Bdd.Suite.Tests;

/// <summary>The tests that point Runner.CancelInput, a process-wide setting,
/// somewhere else; they never run at the same time.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class CancelInputCollection
{
    public const string Name = "Runner.CancelInput";
}

/// <summary>
/// Step addresses, the step observer, notes and detail, the event writer and
/// cancel (spec/events.md): the parts the events corpus does not reach.
/// </summary>
[Collection(CancelInputCollection.Name)]
public sealed class EventsTests
{
    private static readonly Corpus Corpus = Corpus.Find();

    private static OrderedMap Parse(string yaml) => (OrderedMap)SuiteDocument.Load(yaml).Value!;

    /// <summary>A suite and a library it imports, in a scratch folder.</summary>
    private static (string Folder, string Suite) Files(string suite, string library)
    {
        var folder = Directory.CreateTempSubdirectory("bdd-addr-").FullName;
        Directory.CreateDirectory(Path.Combine(folder, "_lib"));
        File.WriteAllText(Path.Combine(folder, "_lib", "lib.yml"), library);
        var path = Path.Combine(folder, "suite.yml");
        File.WriteAllText(path, suite);
        return (folder, path);
    }

    private const string Library = """
        metaSteps:
          - name: imported
            steps:
              - given: an imported step
                action: core.noop
        """;

    private const string Addressed = """
        suite: addressed
        imports: [_lib/lib.yml]
        setup:
          - given: suite setup
            action: core.noop
        beforeEach:
          - given: before each
            action: core.noop
        metaSteps:
          - name: outer
            steps:
              - given: outer first
                action: core.noop
              - meta: inner
          - name: inner
            steps:
              - given: inner only
                action: core.noop
        tests:
          - name: first
            steps:
              - given: a plain step
                action: core.noop
              - meta: outer
              - meta: outer
              - meta: imported
              - when: a table step
                action: core.noop
                table:
                  - { n: 1 }
                  - { n: 2 }
            cleanup:
              - then: a cleanup step
                action: core.noop
          - name: second
            examples:
              - { x: a }
              - { x: b }
            steps:
              - when: an outline step
                action: core.noop
        """;

    [Fact]
    public void EveryStepIsAddressedThroughItsMetaStepsWithoutChangingTheSuite()
    {
        var (folder, path) = Files(Addressed, Library);
        try
        {
            var suite = Parse(File.ReadAllText(path));
            var before = suite.ToJson();
            var library = SuiteExpansion.ReadLibraries(suite, path);
            var definitions = SuiteExpansion.MetaDefinitions(suite, library);
            var origins = SuiteExpansion.MetaOrigins(suite, library);
            var hooks = SuiteExpansion.ExpandedHooks(suite, definitions, origins);
            var cases = SuiteExpansion.Cases(suite);
            var first = SuiteExpansion.ExpandedCase(cases[0], definitions, origins);
            var outlined = SuiteExpansion.ExpandedCase(cases[2], definitions, origins);

            static string Id(OrderedMap step) => step.Text(SuiteExpansion.StepIdKey);
            static string Pointer(OrderedMap step) => step.Text(SuiteExpansion.StepPointerKey);

            Assert.Equal("suiteSetup/0", Id(hooks["setup"][0]));
            Assert.Equal("/setup/0", Pointer(hooks["setup"][0]));
            Assert.Equal("beforeEach/0", Id(hooks["beforeEach"][0]));
            Assert.Equal(
                ["steps/0", "steps/1/outer/0", "steps/1/outer/1/inner/0", "steps/2/outer/0", "steps/2/outer/1/inner/0",
                 "steps/3/imported/0", "steps/4", "steps/4"],
                first["steps"].Select(Id));
            Assert.Equal(["/tests/0/steps/0", "/metaSteps/0/steps/0", "/metaSteps/1/steps/0"],
                first["steps"].Take(3).Select(Pointer));
            Assert.Equal(string.Empty, first["steps"][1].Text(SuiteExpansion.StepFileKey));
            Assert.Equal(Path.Combine(folder, "_lib", "lib.yml"), first["steps"][5].Text(SuiteExpansion.StepFileKey));
            Assert.Equal("/metaSteps/0/steps/0", Pointer(first["steps"][5]));
            Assert.Equal("cleanup/0", Id(first["cleanup"][0]));
            Assert.Equal("/tests/0/cleanup/0", Pointer(first["cleanup"][0]));
            Assert.Equal("/tests/1/steps/0", Pointer(outlined["steps"][0]));
            Assert.Equal(1L, cases[2].Value(SuiteExpansion.ExamplesRowKey));

            // The parsed suite is the file's, unchanged; the expansion without
            // origins is what it always was.
            Assert.Equal(before, suite.ToJson());
            Assert.False(SuiteExpansion.ExpandedCase(cases[0], definitions)["steps"][0].Has(SuiteExpansion.StepIdKey));
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }

    [Theory]
    [InlineData("steps/1", -1, -1, "steps/1")]
    [InlineData("steps/1", 2, -1, "steps/1#row2")]
    [InlineData("steps/1", -1, 0, "steps/1@table0")]
    [InlineData("steps/1/m/0", 1, 3, "steps/1/m/0#row1@table3")]
    public void AnIdCarriesItsRows(string address, int examplesRow, int tableRow, string id) =>
        Assert.Equal(id, StepRef.IdOf(address, examplesRow, tableRow));

    /// <summary>Records every observer call, in order.</summary>
    private sealed class Recorder : IRunObserver, IStepObserver
    {
        public List<string> Calls { get; } = [];
        public List<StepResult> Finished { get; } = [];
        public List<(StepRef Step, string Text)> Notes { get; } = [];

        public void CaseStarted(string suite, string caseName) => Calls.Add("case+ " + caseName);
        public void CaseFinished(string suite, CaseResult result) => Calls.Add("case- " + result.Name);
        public void Entry(TraceEntry entry) { }
        public void StepStarted(StepRef step, DateTimeOffset at) => Calls.Add("step+ " + step.Id);

        public void StepFinished(StepResult result)
        {
            Calls.Add("step- " + result.Step.Id + " " + result.Status);
            Finished.Add(result);
        }

        public void Note(StepRef step, string text, DateTimeOffset at) => Notes.Add((step, text));
    }

    private static readonly SuiteSchema Schema = SuiteSchema.Load(Corpus.SchemaRoot);

    private static (SuiteResult Result, Recorder Recorder) RunWith(string yaml, IExtension? extension = null, bool dryRun = false)
    {
        var path = Path.Combine(Directory.CreateTempSubdirectory("bdd-obs-").FullName, "suite.yml");
        File.WriteAllText(path, yaml);
        var composite = extension is null ? Composite.CoreOnly : Composite.Compose([extension]);
        var run = new RunExtensions(composite, composite.Start(new Dictionary<string, string>()));
        var recorder = new Recorder();
        var result = Executor.RunFile(path, Parse(yaml), Schema, new RunOptions { Observer = recorder, DryRun = dryRun }, new Trace(), run);
        Directory.Delete(Path.GetDirectoryName(path)!, recursive: true);
        return (result, recorder);
    }

    [Fact]
    public void EveryReachedStepIsStartedThenFinishedAndAnUnreachedOneIsNeither()
    {
        var (_, recorder) = RunWith("""
            suite: observed
            tests:
              - name: one
                steps:
                  - given: a value
                    action: core.set
                    value: Up
                    captureAs: state
                  - then: it is Down, which it is not
                    action: core.noop
                    asserts:
                      - { var: state, equals: Down }
                  - then: never reached
                    action: core.noop
                cleanup:
                  - then: guarded away
                    action: core.noop
                    ifCapture: nothing
            """);
        Assert.Equal(
            ["case+ one", "step+ steps/0", "step- steps/0 passed", "step+ steps/1", "step- steps/1 failed",
             "step+ cleanup/0", "step- cleanup/0 skipped", "case- one"],
            recorder.Calls);
        var failed = recorder.Finished[1];
        Assert.Equal(Reason.Assertion, failed.Reason);
        Assert.Equal(9, failed.Step.Line);
        Assert.Equal(new AssertResult("state", "equals", "Down", "Up", true, false), failed.Asserts.Single());
        Assert.True(failed.Returned);
        Assert.Equal("Up", recorder.Finished[0].Value);
        Assert.Equal(Reason.Guard, recorder.Finished[2].Reason);
        Assert.True(recorder.Finished[1].Finished >= recorder.Finished[1].Started);
    }

    [Fact]
    public void AnActionSeesItsStepAndCanNoteAndExplainAFailure()
    {
        StepRef? seen = null;
        var extension = new Extension
        {
            Name = "probe",
            Actions =
            [
                new ActionRegistration("probe.verdict", request =>
                {
                    seen = request.Ref;
                    request.Note("checking 2 of 3");
                    request.Note(string.Empty);
                    var checks = new OrderedMap();
                    checks.Set("failed", new List<object?> { "disk", "memory" });
                    throw ActionException.Failed("2 checks failed").WithDetail(checks);
                }),
            ],
        };
        var (_, recorder) = RunWith("""
            suite: noted
            tests:
              - name: verdict
                steps:
                  - when: the verdict is asked for
                    action: probe.verdict
            """, extension);
        Assert.NotNull(seen);
        Assert.Equal("steps/0", seen!.Id);
        Assert.Equal("verdict", seen.Case);
        Assert.Equal("noted", seen.Suite);
        Assert.Equal("when", seen.Keyword);
        var note = Assert.Single(recorder.Notes);
        Assert.Equal(("steps/0", "checking 2 of 3"), (note.Step.Id, note.Text));
        var finished = Assert.Single(recorder.Finished);
        Assert.Equal("""{"failed":["disk","memory"]}""", ((OrderedMap)finished.Detail!).ToJson());
        Assert.False(finished.Returned);
        Assert.Contains("2 checks failed", finished.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ARequestBuiltOutsideARunHasNoReferenceAndItsNotesGoNowhere()
    {
        var request = new ActionRequest { Step = new OrderedMap() };
        Assert.Null(request.Ref);
        request.Note("nobody listens");
    }

    [Fact]
    public void ADryRunTellsTheStepObserverNothing()
    {
        var (_, recorder) = RunWith("""
            suite: dry
            tests:
              - name: one
                steps:
                  - given: a step
                    action: core.noop
            """, dryRun: true);
        Assert.Empty(recorder.Calls);
    }

    [Fact]
    public void TheWriterRedactsEveryTextCutsALongValueAndWritesSchemaValidLines()
    {
        // The secret is made at run time: no literal stands for one in a test.
        var secret = Guid.NewGuid().ToString("N");
        var folder = Directory.CreateTempSubdirectory("bdd-writer-").FullName;
        var path = Path.Combine(folder, "events.jsonl");
        try
        {
            using (var writer = new EventWriter(path, text => text.Replace(secret, "***", StringComparison.Ordinal)))
            {
                var step = new StepRef { Id = "steps/0", Phase = Phase.Step, Suite = "s", Case = "c", Label = "l" };
                writer.RunStarted(["s.yml"]);
                writer.StepStarted(step, DateTimeOffset.UtcNow);
                writer.Note(step, "token " + secret, DateTimeOffset.UtcNow);
                var value = new OrderedMap();
                value.Set("token", secret);
                writer.StepFinished(new StepResult
                {
                    Step = step, Status = Status.Failed, Reason = Reason.Action,
                    Started = DateTimeOffset.UtcNow, Finished = DateTimeOffset.UtcNow,
                    Message = "refused " + secret, Returned = true, Value = value,
                    Detail = new string('x', EventWriter.ValueLimit + 10),
                    Asserts = [new AssertResult("token", "equals", secret, null, false, false)],
                });
                writer.RunFinished("failed", Exit.Failed);
            }
            var text = File.ReadAllText(path);
            Assert.DoesNotContain(secret, text, StringComparison.Ordinal);
            var events = EventsCorpusTests.ReadEvents(path);
            Assert.Equal(["runStarted", "stepStarted", "note", "stepFinished", "runFinished"],
                events.Select(one => one["event"]!.GetValue<string>()));
            var finished = events[3];
            Assert.Equal("refused ***", finished["message"]!.GetValue<string>());
            Assert.Equal("***", finished["value"]!["token"]!.GetValue<string>());
            Assert.True(finished["detailTruncated"]!.GetValue<bool>());
            Assert.Equal(EventWriter.ValueLimit, finished["detailPreview"]!.GetValue<string>().Length);
            var assert = (JsonObject)finished["asserts"]![0]!;
            Assert.False(assert.ContainsKey("actual"));
            Assert.Equal("***", assert["expected"]!.GetValue<string>());
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }

    [Fact]
    public void TheCancelAndEventFlagsAreReadAndNamedInTheUsage()
    {
        var options = CommandLine.Parse(["run", "--path", "x.yml", "--events", "e.jsonl", "--cancel-file", "stop", "--cancel-on-stdin-close"]);
        Assert.Equal("e.jsonl", options.Events);
        Assert.Equal("stop", options.CancelFile);
        Assert.True(options.CancelOnStdinClose);
        Assert.False(CommandLine.Parse(["run", "--path", "x.yml"]).CancelOnStdinClose);
        Assert.Contains("[--events f.jsonl] [--cancel-on-stdin-close] [--cancel-file <path>]", CommandLine.Usage, StringComparison.Ordinal);
        Assert.Throws<CommandLineException>(() => CommandLine.Parse(["run", "--path", "x.yml", "--events"]));
    }

    /// <summary>A reader whose end comes when the test says so, as a pipe's does
    /// when the host closes it.</summary>
    private sealed class ClosingReader : TextReader
    {
        public ManualResetEventSlim Closed { get; } = new(false);

        public override string? ReadLine()
        {
            Closed.Wait();
            return null;
        }
    }

    [Fact]
    public void ClosingStandardInputCancelsTheRunAndItsCleanupStillRuns()
    {
        var folder = Directory.CreateTempSubdirectory("bdd-stdin-").FullName;
        var suite = Path.Combine(folder, "cancel.yml");
        File.Copy(Corpus.Path("events/cancel.yml"), suite);
        var events = Path.Combine(folder, "events.jsonl");
        var reader = new ClosingReader();
        var standard = Runner.CancelInput;
        Runner.CancelInput = reader;
        try
        {
            using var closer = new Timer(_ => reader.Closed.Set(), null, TimeSpan.FromSeconds(1), Timeout.InfiniteTimeSpan);
            var clock = System.Diagnostics.Stopwatch.StartNew();
            var report = Runner.Execute(CommandLine.Parse(
                ["run", "--schema-root", Corpus.SchemaRoot, "--path", suite, "--events", events, "--cancel-on-stdin-close"]));
            Assert.Equal(Exit.Failed, report.Code);
            Assert.True(clock.Elapsed.TotalSeconds < 5, $"took {clock.Elapsed.TotalSeconds:F1}s");
            Assert.Contains("The run was cancelled", report.Out, StringComparison.Ordinal);
            var lines = EventsCorpusTests.ReadEvents(events);
            Assert.Contains(lines, one => one["event"]!.GetValue<string>() == "stepFinished"
                && one["step"]!["id"]!.GetValue<string>() == "cleanup/0"
                && one["status"]!.GetValue<string>() == Status.Passed);
            Assert.Equal("cancelled", lines[^1]["status"]!.GetValue<string>());
        }
        finally
        {
            Runner.CancelInput = standard;
            Directory.Delete(folder, recursive: true);
        }
    }

    [Fact]
    public void ARunWithoutCancelFlagsIgnoresStandardInputAndADryRunWritesNoEvents()
    {
        var folder = Directory.CreateTempSubdirectory("bdd-plain-").FullName;
        var events = Path.Combine(folder, "events.jsonl");
        var standard = Runner.CancelInput;
        // Standard input already at its end: without the flag it means nothing.
        Runner.CancelInput = new StringReader(string.Empty);
        try
        {
            var report = Runner.Execute(CommandLine.Parse(
                ["run", "--schema-root", Corpus.SchemaRoot, "--path", Corpus.Path("execute/meta.yml"), "--events", events]));
            Assert.Equal(Exit.Passed, report.Code);
            Assert.Equal("passed", EventsCorpusTests.ReadEvents(events)[^1]["status"]!.GetValue<string>());

            var dry = Path.Combine(folder, "dry.jsonl");
            Runner.Execute(CommandLine.Parse(
                ["run", "--schema-root", Corpus.SchemaRoot, "--path", Corpus.Path("execute/meta.yml"), "--events", dry, "--dry-run"]));
            Assert.False(File.Exists(dry));
        }
        finally
        {
            Runner.CancelInput = standard;
            Directory.Delete(folder, recursive: true);
        }
    }

    [Fact]
    public void ACancelBeforeTheFirstCaseRunsNothingAndStillExitsOne()
    {
        var folder = Directory.CreateTempSubdirectory("bdd-early-").FullName;
        var stop = Path.Combine(folder, "stop");
        File.WriteAllText(stop, "now");
        var events = Path.Combine(folder, "events.jsonl");
        try
        {
            var report = Runner.Execute(CommandLine.Parse(
                ["run", "--schema-root", Corpus.SchemaRoot, "--path", Corpus.Path("execute/meta.yml"), "--events", events, "--cancel-file", stop]));
            Assert.Equal(Exit.Failed, report.Code);
            var lines = EventsCorpusTests.ReadEvents(events);
            Assert.DoesNotContain(lines, one => one["event"]!.GetValue<string>() == "stepStarted");
            Assert.All(lines.Where(one => one["event"]!.GetValue<string>() == "caseFinished"),
                one => Assert.Equal(Reason.Cancelled, one["reason"]!.GetValue<string>()));
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }
}
