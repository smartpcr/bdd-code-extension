using Bdd.Suite.Cli;
using Bdd.Suite.Extensions;
using Bdd.Suite.Run;

namespace Bdd.Suite.Tests;

public sealed class RunnerTests
{
    /// <summary>The corpus's schema folder, which every verb here reads with
    /// --schema-root: this repository has no test/e2e/schema to walk up
    /// to.</summary>
    private static string SchemaRoot => Corpus.Find().SchemaRoot;

    private static Options Parse(string line) =>
        CommandLine.Parse(line.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));

    /// <summary>One command line with the corpus schema named.</summary>
    private static Options ParseWithSchema(string line) => Parse(line + " --schema-root " + SchemaRoot);

    /// <summary>One fixture by its path under conformance/.</summary>
    private static string Fixture(string relative) => Corpus.Find().Path(relative);

    [Fact]
    public void ActionsListsWhatThisBindingImplements()
    {
        var report = Runner.Execute(Parse("actions"));
        Assert.Equal(Exit.Passed, report.Code);
        Assert.Equal("core.fail\ncore.noop\ncore.record\ncore.set\ncore.sleep\nwait", report.Out);
        Assert.StartsWith("[", Runner.Execute(Parse("actions --json")).Out.TrimStart(), StringComparison.Ordinal);

        // An extension's actions are listed with the core's.
        var extension = new Extension
        {
            Name = "fixture",
            Actions = [new ActionRegistration("fixture.get", _ => null)],
        };
        var extended = Runner.Execute(Parse("actions"), Composite.Compose(extension));
        Assert.Contains("fixture.get", extended.Out.Split('\n'));
    }

    [Fact]
    public void LintIsCleanOnACorpusSuiteThatIs()
    {
        var report = Runner.Execute(ParseWithSchema("lint --path " + Fixture("execute/hooks.yml")));
        Assert.Equal(Exit.Passed, report.Code);
        Assert.Contains("Lint clean", report.Out, StringComparison.Ordinal);
    }

    [Fact]
    public void LintRefusesAFileThatDoesNotValidate()
    {
        var report = Runner.Execute(ParseWithSchema("lint --path " + Fixture("validate/typos.yml")));
        Assert.Equal(Exit.Refused, report.Code);
        Assert.Contains("E101", report.Out, StringComparison.Ordinal);
        var asJson = Runner.Execute(ParseWithSchema("lint --json --path " + Fixture("validate/typos.yml")));
        Assert.Contains("\"code\": \"E101\"", asJson.Out, StringComparison.Ordinal);
    }

    [Fact]
    public void APathThatNamesNothingIsAHarnessError()
    {
        var report = Runner.Execute(ParseWithSchema("lint --path nosuchfile.yml"));
        Assert.Equal(Exit.Refused, report.Code);
        Assert.Contains("names no file", report.Errors, StringComparison.Ordinal);
        Assert.Equal(Exit.Refused, Runner.Execute(ParseWithSchema("run --path nosuchfile.yml")).Code);
        Assert.Equal(Exit.Refused, Runner.Execute(Parse("list --path nosuchfile.yml")).Code);
    }

    [Fact]
    public void ListNamesTheCasesARunWouldSelect()
    {
        var report = Runner.Execute(Parse("list --path " + Fixture("execute/tags.yml")));
        Assert.Equal(Exit.Passed, report.Code);
        Assert.Contains("the-selected-one", report.Out, StringComparison.Ordinal);
        Assert.Contains("the-unselected-one", report.Out, StringComparison.Ordinal);

        var filtered = Runner.Execute(Parse("list --tags wanted --path " + Fixture("execute/tags.yml")));
        Assert.Contains("the-selected-one", filtered.Out, StringComparison.Ordinal);
        Assert.DoesNotContain("the-unselected-one", filtered.Out, StringComparison.Ordinal);
    }

    [Fact]
    public void ARunThatPassesExitsZeroAndOneThatFailsExitsOne()
    {
        Assert.Equal(Exit.Passed, Runner.Execute(ParseWithSchema("run --path " + Fixture("execute/hooks.yml"))).Code);
        var failed = Runner.Execute(ParseWithSchema("run --path " + Fixture("execute/gherkin.yml")));
        Assert.Equal(Exit.Failed, failed.Code);
        Assert.Contains("One or more tests failed", failed.Out, StringComparison.Ordinal);
    }

    [Fact]
    public void ARunWritesTheTraceAndTheResultsItWasAskedFor()
    {
        var scratch = Path.Combine(Path.GetTempPath(), "suiterun-verbs-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(scratch);
        try
        {
            var tracePath = Path.Combine(scratch, "nested", "trace.json");
            var resultsPath = Path.Combine(scratch, "results.xml");
            var report = Runner.Execute(ParseWithSchema(
                $"run --path {Fixture("execute/hooks.yml")} --trace-file {tracePath} --results {resultsPath}"));
            Assert.Equal(Exit.Passed, report.Code);
            Assert.Contains("\"phase\"", File.ReadAllText(tracePath), StringComparison.Ordinal);
            Assert.Contains("<test-run", File.ReadAllText(resultsPath), StringComparison.Ordinal);

            var junitPath = Path.Combine(scratch, "results-junit.xml");
            Runner.Execute(ParseWithSchema(
                $"run --path {Fixture("execute/hooks.yml")} --results {junitPath} --format junit"));
            Assert.Contains("<testsuites>", File.ReadAllText(junitPath), StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(scratch, true);
        }
    }

    [Fact]
    public void ADryRunValidatesAndRunsNothing()
    {
        var report = Runner.Execute(ParseWithSchema("run --dry-run --path " + Fixture("execute/hooks.yml")));
        Assert.Equal(Exit.Passed, report.Code);
        Assert.Contains("live tests were not run", report.Out, StringComparison.Ordinal);
    }

    [Fact]
    public void AFileThatIsNotYamlIsAHarnessErrorForEveryVerbThatReadsIt()
    {
        var broken = Fixture("validate/broken.yml");
        foreach (var verb in new[] { "run", "list" })
        {
            var report = Runner.Execute(ParseWithSchema($"{verb} --path {broken}"));
            Assert.Equal(Exit.Refused, report.Code);
            Assert.Contains("not valid YAML", report.Errors, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void ASchemaRootIsUsedWithNoRepositoryWalkAndWithoutOneTheRootMustBeFound()
    {
        var scratch = Path.Combine(Path.GetTempPath(), "suiterun-roots-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(scratch);
        try
        {
            // No test/e2e/schema above a fresh temporary folder: with
            // --schema-root the given folder is used, and findings are relative
            // to the working directory.
            var given = Parse("lint --path a.yml --schema-root " + SchemaRoot);
            var (root, schemaRoot) = Runner.Roots(given, scratch);
            Assert.Equal(Path.GetFullPath(scratch), root);
            Assert.Equal(Path.GetFullPath(SchemaRoot), schemaRoot);

            // A relative --schema-root is relative to the working directory.
            Directory.CreateDirectory(Path.Combine(scratch, "here"));
            Assert.Equal(Path.Combine(Path.GetFullPath(scratch), "here"),
                Runner.Roots(Parse("lint --path a.yml --schema-root here"), scratch).SchemaRoot);

            // Without it, and with nothing to walk up to, the run is refused by
            // name.
            var refused = Assert.Throws<IOException>(() => Runner.Roots(Parse("lint --path a.yml"), scratch));
            Assert.Equal(
                "the workspace root cannot be found from this directory (no test/e2e/schema above it); pass --schema-root.",
                refused.Message);

            // A workspace in the default layout is found by walking up, and its
            // schema is the one under test/e2e/schema.
            var nested = Path.Combine(scratch, "test", "e2e", "suites");
            Directory.CreateDirectory(nested);
            Directory.CreateDirectory(Path.Combine(scratch, "test", "e2e", "schema"));
            var found = Runner.Roots(Parse("lint --path a.yml"), nested);
            Assert.Equal(Path.GetFullPath(scratch), found.Repository);
            Assert.Equal(Path.Combine(Path.GetFullPath(scratch), "test", "e2e", "schema"), found.SchemaRoot);
            // With a workspace root and --schema-root, findings are relative to
            // the workspace root.
            Assert.Equal(Path.GetFullPath(scratch),
                Runner.Roots(Parse("lint --path a.yml --schema-root " + SchemaRoot), nested).Repository);
        }
        finally
        {
            Directory.Delete(scratch, true);
        }
    }

    [Fact]
    public void RunMapsACommandLineToAnExitCodeAndWritesBothStreams()
    {
        var stdout = new StringWriter();
        var stderr = new StringWriter();
        Assert.Equal(Exit.Passed, Runner.Run(["actions"], stdout, stderr));
        Assert.Contains("core.noop", stdout.ToString(), StringComparison.Ordinal);
        Assert.Equal(string.Empty, stderr.ToString());

        stdout = new StringWriter();
        stderr = new StringWriter();
        Assert.Equal(Exit.Refused, Runner.Run(["frobnicate"], stdout, stderr));
        Assert.Contains("there is no verb called frobnicate", stderr.ToString(), StringComparison.Ordinal);
        Assert.Equal(string.Empty, stdout.ToString());

        stdout = new StringWriter();
        stderr = new StringWriter();
        Assert.Equal(Exit.Refused, Runner.Run(["lint", "--schema-root", SchemaRoot, "--path", "nosuchfile.yml"], stdout, stderr));
        Assert.Contains("names no file", stderr.ToString(), StringComparison.Ordinal);
    }
}
