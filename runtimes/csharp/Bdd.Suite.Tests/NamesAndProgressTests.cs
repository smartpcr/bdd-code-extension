using Bdd.Suite.Cli;
using Bdd.Suite.Execution;
using Bdd.Suite.Model;
using Bdd.Suite.Run;
using Bdd.Suite.Schema;
using Bdd.Suite.Tracing;

namespace Bdd.Suite.Tests;

/// <summary>The tests that point Runner.ProgressWriter, a process-wide setting,
/// somewhere else; they never run at the same time.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class ProgressWriterCollection
{
    public const string Name = "Runner.ProgressWriter";
}

/// <summary>
/// The name filter, run progress and its observer, the action worker and the
/// embedded core (docs/packages, D2; spec/progress.md). These began as the local
/// patches P2-P5 of a consumer's copy of this runtime; the corpus proves the
/// contract, and these tests the parts the corpus does not reach.
/// </summary>
[Collection(ProgressWriterCollection.Name)]
public sealed class NamesAndProgressTests(Xunit.Abstractions.ITestOutputHelper output)
{
    private static readonly Corpus Corpus = Corpus.Find();

    private static Options Parse(params string[] line) => CommandLine.Parse(line, Where.CorpusComposite);

    /// <summary>A run of one corpus suite with progress on, and what it printed.</summary>
    private static (Report Report, List<string> Lines) RunWithProgress(params string[] extra)
    {
        var printed = new StringWriter();
        var standard = Runner.ProgressWriter;
        Runner.ProgressWriter = printed;
        try
        {
            var report = Runner.Execute(Parse(["run", "--schema-root", Corpus.SchemaRoot, .. extra]), Where.CorpusComposite);
            return (report, printed.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(line => line.TrimEnd('\r')).ToList());
        }
        finally
        {
            Runner.ProgressWriter = standard;
        }
    }

    [Fact]
    public void NameAndProgressAreReadAndNamedInTheUsage()
    {
        var options = Parse("run", "--path", "x.yml", "--name", " place-* , order-? ,", "--name", "third", "--progress");
        Assert.Equal(["place-*", "order-?", "third"], options.Names);
        Assert.True(options.Progress);
        Assert.False(Parse("run", "--path", "x.yml").Progress);
        Assert.Contains("[--name a*,b?]", CommandLine.Usage, StringComparison.Ordinal);
        Assert.Contains("[--progress]", CommandLine.Usage, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("place-an-order", "*-an-order", true)]
    [InlineData("order-1", "order-?", true)]
    [InlineData("order-22", "order-?", false)]
    [InlineData("read-the-stock", "*-an-order", false)]
    [InlineData("Place-an-order", "place-*", false)]
    public void ANameMatchesAGlobOverTheWholeName(string name, string glob, bool matches) =>
        Assert.Equal(matches, SuiteExpansion.NameMatches(name, [glob]));

    [Fact]
    public void NoNameFilterSelectsEveryCase() => Assert.True(SuiteExpansion.NameMatches("anything", []));

    [Fact]
    public void EveryListEntry()
    {
        var checked_ = 0;
        var pending = new List<string>();
        foreach (var entry in (Corpus.Manifest().List("lists") ?? []).OfType<OrderedMap>())
        {
            if (Corpus.PendingIn(entry, "csharp"))
            {
                pending.Add(entry.Text("suite"));
                continue;
            }
            var line = new List<string> { "list", "--schema-root", Corpus.SchemaRoot, "--path", Corpus.Path(entry.Text("suite")) };
            foreach (var (flag, key) in new[] { ("--name", "names"), ("--tags", "tags") })
            {
                if (entry.Text(key).Length > 0)
                {
                    line.Add(flag);
                    line.Add(entry.Text(key));
                }
            }
            var report = Runner.Execute(Parse([.. line]), Where.CorpusComposite);
            Assert.Equal(0, report.Code);
            var listed = report.Out.Split('\n', StringSplitOptions.RemoveEmptyEntries)
                .Select(row => row[(row.IndexOf("  ", StringComparison.Ordinal) + 2)..].TrimEnd('\r')).ToList();
            Assert.Equal((entry.List("expected") ?? []).OfType<string>().ToList(), listed);
            checked_++;
        }
        Corpus.ReportPending(output, "lists", pending);
        Assert.Equal(2, checked_);
    }

    [Fact]
    public void ATraceTellsItsCallbackEveryEntryInTheOrderItRecordsThem()
    {
        var trace = new Trace();
        var seen = new List<string>();
        trace.Added = entry => seen.Add(entry.Step);
        trace.Add(Phase.Step, "a", "first", "core.noop", "passed", string.Empty);
        trace.Add(Phase.Step, "a", "second", "core.noop", "passed", string.Empty);
        Assert.Equal(["first", "second"], seen);
        Assert.Equal(2, trace.Entries.Count);
    }

    private sealed class Recorder : IRunObserver
    {
        public List<string> Heard { get; } = [];

        public void CaseStarted(string suite, string caseName) => Heard.Add($"start {suite}::{caseName}");

        public void CaseFinished(string suite, CaseResult result) => Heard.Add($"end {suite}::{result.Name} {result.Status}");

        public void Entry(TraceEntry entry) => Heard.Add($"entry {entry.Phase} {entry.Case}");
    }

    [Fact]
    public void AnObserverHearsSelectedCasesOnlyAndNeverChangesTheTrace()
    {
        var path = Corpus.Path("execute/names-and-tags.yml");
        var suite = Corpus.Yaml("execute/names-and-tags.yml");
        var schema = SuiteSchema.Load(Corpus.SchemaRoot);
        RunOptions Options(IRunObserver? observer) => new() { Tags = ["wanted"], Names = ["*-order"], Observer = observer };

        var plain = new Trace();
        Executor.RunFile(path, suite, schema, Options(null), plain, Where.CorpusRun());
        var recorder = new Recorder();
        var observed = new Trace();
        Executor.RunFile(path, suite, schema, Options(recorder), observed, Where.CorpusRun());

        Assert.Equal(plain.ToJson(), observed.ToJson());
        Assert.Equal(
        [
            "start names-and-tags::a-wanted-order", "entry step a-wanted-order", "entry case a-wanted-order",
            "end names-and-tags::a-wanted-order passed", "entry case an-unwanted-order", "entry case a-wanted-refund",
        ], recorder.Heard);
        Assert.Null(observed.Added);
    }

    [Fact]
    public void ADryRunTellsTheObserverNothing()
    {
        var recorder = new Recorder();
        Executor.RunFile(Corpus.Path("execute/hooks.yml"), Corpus.Yaml("execute/hooks.yml"), SuiteSchema.Load(Corpus.SchemaRoot),
            new RunOptions { DryRun = true, Observer = recorder }, new Trace(), Where.CorpusRun());
        Assert.Empty(recorder.Heard);
    }

    [Fact]
    public void TheProgressPrinterWritesTheSpecifiedShape()
    {
        var printed = new StringWriter();
        var printer = new ProgressPrinter(printed);
        printer.Entry(new TraceEntry(Phase.SuiteSetup, string.Empty, "step 1 (core.record)", "core.record", "passed", string.Empty));
        printer.CaseStarted("orders", "place");
        printer.Entry(new TraceEntry(Phase.Step, "place", "the order", "shop.order", "failed", "action"));
        printer.Entry(new TraceEntry(Phase.Case, "place", string.Empty, string.Empty, "failed", "action"));
        printer.CaseFinished("orders", new CaseResult { Name = "place", Status = Status.Failed, Message = "two\nlines", DurationSec = 2.6 });
        printer.CaseFinished("orders", new CaseResult { Name = "later", Status = Status.Skipped });
        printer.CaseFinished("orders", new CaseResult { Name = "ok", Status = Status.Passed });
        printer.CaseFinished("orders", new CaseResult { Name = "silent", Status = Status.Error });
        printer.Summary();
        Assert.Equal(
        [
            "    suite-setup   step 1 (core.record) passed",
            "StartGroup: orders::place",
            "    step          the order (shop.order) failed [action]",
            "    failure: two lines",
            "EndGroup: orders::place [Failed] (3s)",
            "EndGroup: orders::later [Skipped] (0s)",
            "EndGroup: orders::ok [Passed] (0s)",
            "EndGroup: orders::silent [Failed] (0s)",
            "Summary: Total=4, Passed=1, Failed=2, Blocked=0, Not Run=0, Skipped=1",
        ], printed.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(line => line.TrimEnd('\r')));
    }

    [Fact]
    public void ByDefaultProgressGoesToStandardOutput() => Assert.Same(Console.Out, Runner.ProgressWriter);

    [Fact]
    public void ARunWithoutProgressPrintsNothingAndOneWithItSummarisesEveryFile()
    {
        var (quiet, none) = RunWithProgress("--path", Corpus.Path("execute/hooks.yml"));
        Assert.Equal(0, quiet.Code);
        Assert.Empty(none);

        // Three files in ordinal order; the filter selects nothing in the first.
        var (report, lines) = RunWithProgress("--progress", "--path", Corpus.Path("execute/names*.yml"), "--name", "first,*-an-order");
        output.WriteLine(string.Join('\n', lines));
        Assert.Equal(0, report.Code);
        Assert.Equal(["names-none::first", "names::place-an-order", "names::cancel-an-order"],
            lines.Where(line => line.StartsWith("StartGroup: ", StringComparison.Ordinal)).Select(line => line["StartGroup: ".Length..]));
        Assert.Equal("Summary: Total=3, Passed=3, Failed=0, Blocked=0, Not Run=0, Skipped=0", lines[^1]);
    }

    [Fact]
    public void ACaseWhoseActionThrowsAnythingFailsAndTheRunCarriesOn()
    {
        var trace = new Trace();
        var result = Executor.RunFile(Corpus.Path("execute/worker-throws.yml"), Corpus.Yaml("execute/worker-throws.yml"),
            SuiteSchema.Load(Corpus.SchemaRoot), new RunOptions(), trace, Where.CorpusRun());
        Assert.Equal(
            ["the-case-whose-action-throws|failed|action", "the-case-after-it|passed|"],
            result.Cases.Select(held => $"{held.Name}|{held.Status}|{held.Reason}"));
        Assert.Contains("thrown on purpose", result.Cases[0].Message, StringComparison.Ordinal);
        Assert.Contains(trace.Entries, entry => entry.Phase == Phase.SuiteTeardown && entry.Status == "passed");
    }

    [Fact]
    public void TheEmbeddedCoreIsTheSpecsAndBddSuiteCoreCutsItsBindings()
    {
        Assert.Equal(File.ReadAllText(Path.Combine(Corpus.Root, "spec", "core.catalog.yaml")).ReplaceLineEndings("\n"),
            SuiteSchema.CoreCatalogText().ReplaceLineEndings("\n"));
        var cut = SuiteSchema.Load(Corpus.Path("schema-core-import"));
        var whole = SuiteSchema.Load(Corpus.SchemaRoot);
        foreach (var name in new[] { "core.noop", "core.set", "core.fail", "core.sleep", "core.record", "wait" })
        {
            Assert.Equal(["csharp"], cut.Actions[name].Bindings);
            Assert.Equal(["powershell", "csharp", "go", "rust", "typescript"], whole.Actions[name].Bindings);
        }
        Assert.Equal(7, cut.Actions.Count);
    }

    [Fact]
    public void BddSuiteCoreIsReadWholeWhenTheImporterListsNoBindings()
    {
        var root = Path.Combine(Path.GetTempPath(), "suiterun-core-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            File.WriteAllText(Path.Combine(root, "actions.catalog.yaml"), "catalogVersion: 1\nimports: [ 'bdd-suite:core' ]\n");
            File.Copy(Corpus.Path("schema-core-import/suite.schema.json"), Path.Combine(root, "suite.schema.json"));
            var schema = SuiteSchema.Load(root);
            Assert.Equal(5, schema.Actions["wait"].Bindings.Count);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }
}
