using Bdd.Suite.Cli;
using Bdd.Suite.Diagnostics;
using Bdd.Suite.Execution;
using Bdd.Suite.Extensions;
using Bdd.Suite.Model;
using Bdd.Suite.Run;
using Bdd.Suite.Schema;
using Bdd.Suite.Tracing;
using Bdd.Suite.Validation;

namespace Bdd.Suite.Tests;

/// <summary>
/// The extension API (DEC-S03): composing extensions, and what each of its five
/// parts does to lint and to a run.
/// </summary>
public sealed class ExtensionTests
{
    private static OrderedMap Parse(string text) =>
        SuiteDocument.Load(text).Value as OrderedMap
        ?? throw new InvalidOperationException("the text does not hold a mapping");

    private static ExtensionException Refused(params IExtension[] extensions) =>
        Assert.Throws<ExtensionException>(() => Composite.Compose(extensions));

    [Fact]
    public void TheCoreAloneHasItsActionsItsRootsAndTheDefaultPrefix()
    {
        var core = Composite.CoreOnly;
        Assert.Equal(["core.fail", "core.noop", "core.record", "core.set", "core.sleep", "wait"], core.Names());
        Assert.Equal(["capture", "param", "var", "row", "timeoutSec", "defaults"], core.Roots);
        Assert.Empty(core.ContextKeys);
        Assert.Empty(core.Options);
        Assert.Equal("BDD_SUITE_", core.EnvPrefix);
        Assert.Equal(Composite.DefaultEnvPrefix, core.EnvPrefix);
        Assert.Null(core.Actions["wait"].Handler);
        Assert.Equal("the core", core.Actions["core.noop"].OwnerName);
    }

    [Fact]
    public void ANameTwoExtensionsDefineOrOneTakenFromTheCoreIsRefused()
    {
        var one = new Extension { Name = "one", Actions = [new ActionRegistration("x.get", _ => null)] };
        var two = new Extension { Name = "two", Actions = [new ActionRegistration("x.get", _ => null)] };
        Assert.Equal("Action x.get is defined by both one and two.", Refused(one, two).Message);
        Assert.Equal("Action core.noop is defined by both the core and one.",
            Refused(new Extension { Name = "one", Actions = [new ActionRegistration("core.noop", _ => null)] }).Message);
        Assert.Equal("Action wait is defined by both the core and one.",
            Refused(new Extension { Name = "one", Actions = [new ActionRegistration("wait", _ => null)] }).Message);

        Assert.Equal("Context key host is defined by both one and two.",
            Refused(new Extension { Name = "one", ContextKeys = ["host"] },
                new Extension { Name = "two", ContextKeys = ["host"] }).Message);
        Assert.Equal("Context key capture is defined by both the core and one.",
            Refused(new Extension { Name = "one", ContextKeys = ["capture"] }).Message);

        Assert.Equal("Option --region is defined by both one and two.",
            Refused(new Extension { Name = "one", Options = [new ExtensionOption("--region", "a")] },
                new Extension { Name = "two", Options = [new ExtensionOption("--region", "b")] }).Message);
        Assert.Equal("Option --path is defined by both the core and one.",
            Refused(new Extension { Name = "one", Options = [new ExtensionOption("--path", "a")] }).Message);
        Assert.Equal("one declares the option -Region; an option is --lower-case-words.",
            Refused(new Extension { Name = "one", Options = [new ExtensionOption("-Region", "a")] }).Message);

        Assert.Equal("one sets the environment prefix A_ and two sets B_.",
            Refused(new Extension { Name = "one", EnvPrefix = "A_" }, new Extension { Name = "two", EnvPrefix = "B_" }).Message);
        // Two extensions that agree on a prefix compose.
        Assert.Equal("A_", Composite.Compose(
            new Extension { Name = "one", EnvPrefix = "A_" }, new Extension { Name = "two", EnvPrefix = "A_" }).EnvPrefix);
    }

    [Fact]
    public void AClashIsRefusedByTheCommandLineWithExitTwoBeforeAnythingRuns()
    {
        var one = new Extension { Name = "one", ContextKeys = ["host"] };
        var two = new Extension { Name = "two", ContextKeys = ["host"] };
        var stdout = new StringWriter();
        var stderr = new StringWriter();
        Assert.Equal(Exit.Refused, Runner.Run(["actions"], stdout, stderr, one, two));
        Assert.Equal(string.Empty, stdout.ToString());
        Assert.Contains("Context key host is defined by both one and two.", stderr.ToString(), StringComparison.Ordinal);
    }

    /// <summary>An interface-only extension: every part but the name comes
    /// from the interface's defaults.</summary>
    private sealed class Bare : IExtension
    {
        public string Name => "bare";
    }

    [Fact]
    public void AnExtensionImplementsOnlyThePartsItAdds()
    {
        IExtension bare = new Bare();
        Assert.Empty(bare.Actions);
        Assert.Empty(bare.ContextKeys);
        Assert.Empty(bare.Options);
        Assert.Same(ExtensionRules.None, bare.Rules);
        Assert.Null(bare.EnvPrefix);
        Assert.Null(bare.Start(new Dictionary<string, string>()).State);
        var composite = Composite.Compose(bare);
        Assert.Equal(Composite.CoreOnly.Names(), composite.Names());
        Assert.Null(new Extension { Name = "x" }.Start(new Dictionary<string, string>()).Context);
    }

    [Fact]
    public void StartingHandsEachExtensionOnlyItsOwnOptionsAndKeepsOnlyItsOwnKeys()
    {
        IReadOnlyDictionary<string, string>? seenByOne = null;
        var one = new Extension
        {
            Name = "one",
            ContextKeys = ["host"],
            Options = [new ExtensionOption("--host", "The host.")],
            OnStart = options =>
            {
                seenByOne = options;
                return new RunState
                {
                    State = "one's",
                    // A value for a key it does not declare is not taken.
                    Context = new Dictionary<string, object?> { ["host"] = options["--host"], ["member"] = "stolen" },
                    Redact = text => text.Replace("secret", "***", StringComparison.Ordinal),
                };
            },
        };
        var two = new Extension
        {
            Name = "two",
            ContextKeys = ["member"],
            Options = [new ExtensionOption("--member", "The member.")],
            OnStart = _ => new RunState { Redact = text => text.Replace("other", "###", StringComparison.Ordinal) },
        };
        var composite = Composite.Compose(one, two);
        Assert.Equal(["host", "member"], composite.ContextKeys);
        Assert.Equal(["capture", "param", "var", "row", "timeoutSec", "defaults", "host", "member"], composite.Roots);
        Assert.Equal(["--host", "--member"], composite.Options.Select(option => option.Flag));

        var started = composite.Start(new Dictionary<string, string> { ["--host"] = "h1", ["--member"] = "m1" });
        Assert.Equal(["--host"], seenByOne!.Keys);
        Assert.Equal("h1", started.Context["host"]);
        Assert.False(started.Context.ContainsKey("member"));
        Assert.Equal("one's", started.State(0));
        Assert.Null(started.State(1));
        Assert.Equal("*** and ###", started.Redact("secret and other"));
        Assert.Equal("plain", StartedExtensions.None.Redact("plain"));
    }

    [Fact]
    public void TheCaseLimitIsTheSmallestAnyExtensionAllows()
    {
        var halves = new Extension { Name = "halves", Rules = new ExtensionRules { CaseLimitSec = (_, declared) => declared / 2 } };
        var ten = new Extension { Name = "ten", Rules = new ExtensionRules { CaseLimitSec = (_, _) => 10 } };
        var none = new Extension { Name = "none" };
        var suite = new OrderedMap();
        Assert.Equal(30, Composite.Compose(halves, none).CaseLimitSec(suite, 60));
        Assert.Equal(10, Composite.Compose(halves, ten).CaseLimitSec(suite, 60));
        Assert.Equal(5, Composite.Compose(halves, ten).CaseLimitSec(suite, 10));
        Assert.Equal(60, Composite.CoreOnly.CaseLimitSec(suite, 60));
    }

    [Fact]
    public void ALintRuleSeesTheParseTheFileAndTheImportsAndItsFindingsAreSortedIn()
    {
        var directory = Path.Combine(Path.GetTempPath(), "suiterun-rule-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            File.WriteAllText(Path.Combine(directory, "library.yml"), "params:\n  - { name: shared, default: x }\n");
            var suitePath = Path.Combine(directory, "suite.yml");
            File.WriteAllText(suitePath, """
                suite: s
                imports: [library.yml]
                tests:
                  - name: c
                    steps:
                      - when: nothing happens
                        action: core.noop
                        captureAs: n
                    asserts:
                      - { var: n.ok, equals: true }
                """);
            RuleInput? seen = null;
            var extension = new Extension
            {
                Name = "rule",
                Rules = new ExtensionRules
                {
                    Lint = input =>
                    {
                        seen = input;
                        return [Diagnostic.Error("E205", input.File, input.Document.At("/suite").Value, "a rule's finding")];
                    },
                },
            };
            var schema = SuiteSchema.Load(Corpus.Find().SchemaRoot);
            var found = Validator.File(suitePath, "suite.yml", schema,
                new ValidationOptions { Extensions = Composite.Compose(extension) });
            Assert.Equal(["E205@1:8"], found.Select(one => $"{one.Code}@{one.Position.Line}:{one.Position.Column}"));
            Assert.NotNull(seen);
            Assert.Equal("suite.yml", seen!.File);
            Assert.Equal("s", seen.Suite.Text("suite"));
            var import = Assert.Single(seen.Imports);
            Assert.Equal(new SuiteImport("library.yml", "/imports/0", Path.Combine(directory, "library.yml")), import);
            Assert.True(seen.Library.Params.ContainsKey("shared"));

            // Without the extension the same file is clean.
            Assert.Empty(Validator.File(suitePath, "suite.yml", schema, new ValidationOptions()));
        }
        finally
        {
            Directory.Delete(directory, true);
        }
    }

    [Fact]
    public void AContextKeyReadsTheValueGivenThenTheSuitesDefaultThenNothing()
    {
        var extension = new Extension
        {
            Name = "keys",
            ContextKeys = ["given", "defaulted", "unset"],
            OnStart = _ => new RunState { Context = new Dictionary<string, object?> { ["given"] = "from the run" } },
        };
        var composite = Composite.Compose(extension);
        var run = new RunExtensions(composite, composite.Start(new Dictionary<string, string>()));
        var suite = Parse("""
            defaults:
              given: from the defaults
              defaulted: from the defaults
            tests:
              - name: c
                steps:
                  - action: core.set
                    value: "${given}|${defaulted}|${unset}"
                    captureAs: seen
                asserts:
                  - { var: seen, equals: "from the run|from the defaults|" }
            """);
        var schema = SuiteSchema.Load(Corpus.Find().SchemaRoot);
        var result = Executor.RunFile(Corpus.Find().Path("probe.yml"), suite, schema, new RunOptions(), new Trace(), run);
        var held = Assert.Single(result.Cases);
        Assert.True(held.Status == Status.Passed, held.Message);

        // Without the extension the key is no root at all.
        var plain = Executor.RunFile(Corpus.Find().Path("probe.yml"), suite, schema, new RunOptions(), new Trace());
        Assert.Contains("E301", Assert.Single(plain.Cases).Message, StringComparison.Ordinal);
    }

    [Fact]
    public void DataflowKnowsAnExtensionsContextKeysAndTheCoreAloneDoesNot()
    {
        var directory = Path.Combine(Path.GetTempPath(), "suiterun-keys-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var suitePath = Path.Combine(directory, "suite.yml");
            File.WriteAllText(suitePath, """
                suite: s
                tests:
                  - name: c
                    steps:
                      - when: the host is set
                        action: core.set
                        value: ${host}
                        captureAs: h
                    asserts:
                      - { var: h, isNotNull: true }
                """);
            var schema = SuiteSchema.Load(Corpus.Find().SchemaRoot);
            var plain = Validator.File(suitePath, "suite.yml", schema, new ValidationOptions());
            Assert.Equal(["E301@7:16"], plain.Select(one => $"{one.Code}@{one.Position.Line}:{one.Position.Column}"));
            var extended = Validator.File(suitePath, "suite.yml", schema, new ValidationOptions
            {
                Extensions = Composite.Compose(new Extension { Name = "keys", ContextKeys = ["host"] }),
            });
            Assert.Empty(extended);
        }
        finally
        {
            Directory.Delete(directory, true);
        }
    }

    [Fact]
    public void TheRecordPathAndParametersUseTheExtensionsPrefix()
    {
        var marker = Path.Combine(Path.GetTempPath(), "suiterun-prefix-" + Guid.NewGuid().ToString("N") + ".txt");
        var suiteDirectory = Path.Combine(Path.GetTempPath(), "suiterun-prefix-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(suiteDirectory);
        var suitePath = Path.Combine(suiteDirectory, "suite.yml");
        File.WriteAllText(suitePath, """
            suite: s
            params:
              - { name: label }
            tests:
              - name: c
                steps:
                  - when: the label is recorded
                    action: core.record
                    marker: ${param.label}
                    captureAs: r
                asserts:
                  - { var: r.marker, equals: from-the-environment }
            """);
        Environment.SetEnvironmentVariable("MINE_RECORD_PATH", marker);
        Environment.SetEnvironmentVariable("MINE_PARAM_LABEL", "from-the-environment");
        try
        {
            var extensions = Composite.Compose(new Extension { Name = "mine", EnvPrefix = "MINE_" });
            var options = CommandLine.Parse(
                ["run", "--schema-root", Corpus.Find().SchemaRoot, "--path", suitePath], extensions);
            var report = Runner.Execute(options, extensions);
            Assert.True(report.Code == Exit.Passed, report.Out + report.Errors);
            Assert.Equal("from-the-environment", File.ReadAllText(marker).Trim());

            // Lint counts the prefixed variable as the parameter's value too.
            var lint = Runner.Execute(CommandLine.Parse(
                ["lint", "--schema-root", Corpus.Find().SchemaRoot, "--path", suitePath], extensions), extensions);
            Assert.True(lint.Code == Exit.Passed, lint.Out);
            var unprefixed = Runner.Execute(CommandLine.Parse(
                ["lint", "--schema-root", Corpus.Find().SchemaRoot, "--path", suitePath]));
            Assert.Contains("E210", unprefixed.Out, StringComparison.Ordinal);
        }
        finally
        {
            Environment.SetEnvironmentVariable("MINE_RECORD_PATH", null);
            Environment.SetEnvironmentVariable("MINE_PARAM_LABEL", null);
            File.Delete(marker);
            Directory.Delete(suiteDirectory, true);
        }
    }

    [Fact]
    public void AReportCarriesEveryTextThroughTheExtensionsRedaction()
    {
        var suite = new SuiteResult { Name = "s secret" };
        suite.Cases.Add(new CaseResult { Name = "c", Status = Status.Failed, Message = "the secret leaked", Output = "secret" });
        static string Hide(string text) => text.Replace("secret", "***", StringComparison.Ordinal);
        foreach (var document in new[] { Reporting.Reports.NUnit3([suite], Hide), Reporting.Reports.JUnit([suite], Hide) })
        {
            Assert.DoesNotContain("secret", document, StringComparison.Ordinal);
            Assert.Contains("the *** leaked", document, StringComparison.Ordinal);
        }
        Assert.Contains("the secret leaked", Reporting.Reports.JUnit([suite]), StringComparison.Ordinal);
    }
}
