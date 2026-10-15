using Bdd.Suite.Cli;
using Bdd.Suite.Extensions;

namespace Bdd.Suite.Tests;

public sealed class CommandLineTests
{
    private static string[] Args(string line) =>
        line.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    [Fact]
    public void EveryVerbParses()
    {
        foreach (var want in new[] { Verb.Lint, Verb.Run, Verb.List })
        {
            var options = CommandLine.Parse(Args($"{CommandLine.Spell(want)} --path a.yml"));
            Assert.Equal(want, options.Verb);
        }
        Assert.Equal(Verb.Actions, CommandLine.Parse(Args("actions")).Verb);
    }

    [Fact]
    public void FlagsAreRead()
    {
        var options = CommandLine.Parse(Args(
            "run --path t/*.yml --tags a,b --results r.xml --format junit --dry-run " +
            "--param one=1 --param two=x=y --trace-file t.json --schema-root s"));

        Assert.Equal("t/*.yml", options.Path);
        Assert.Equal(["a", "b"], options.Tags);
        Assert.Equal("r.xml", options.Results);
        Assert.Equal("t.json", options.TraceFile);
        Assert.Equal(ReportFormat.JUnit, options.Format);
        Assert.True(options.DryRun);
        Assert.Equal(2, options.Params.Count);
        Assert.Equal("two", options.Params[1].Key);
        Assert.Equal("x=y", options.Params[1].Value);
        Assert.Equal("s", options.SchemaRoot);
        Assert.Empty(options.ExtensionOptions);
    }

    [Theory]
    // The lab flags left the core with the lab (DEC-S03): a runtime with no
    // extension refuses them like any other flag it does not know.
    [InlineData("--api-url")]
    [InlineData("--lab-id")]
    [InlineData("--connection-file")]
    public void TheRemovedLabFlagsAreUnknown(string flag)
    {
        var refused = Assert.Throws<CommandLineException>(() =>
            CommandLine.Parse(Args($"run --path a.yml {flag} x")));
        Assert.Contains($"run does not take {flag}", refused.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(flag, CommandLine.Usage, StringComparison.Ordinal);
    }

    [Fact]
    public void AnExtensionsOptionIsAValuedFlagAndTheUsageListsIt()
    {
        var extensions = Composite.Compose(new Extension
        {
            Name = "fixture",
            Options = [new ExtensionOption("--region", "Where it runs.")],
        });
        var options = CommandLine.Parse(Args("run --path a.yml --region eu"), extensions);
        Assert.Equal("eu", options.ExtensionOptions["--region"]);
        var missing = Assert.Throws<CommandLineException>(() =>
            CommandLine.Parse(Args("run --path a.yml --region"), extensions));
        Assert.Contains("--region needs a value", missing.Message, StringComparison.Ordinal);
        var usage = CommandLine.UsageFor(extensions);
        Assert.Contains("--region <value>  Where it runs.", usage, StringComparison.Ordinal);
        Assert.Equal(CommandLine.Usage, CommandLine.UsageFor(null));
        Assert.Equal(CommandLine.Usage, CommandLine.UsageFor(Composite.CoreOnly));
        // A refusal carries the usage with the extension's options in it.
        var refused = Assert.Throws<CommandLineException>(() =>
            CommandLine.Parse(Args("run --path a.yml --nonsense"), extensions));
        Assert.Contains("--region <value>", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void LintFlagsAreRead()
    {
        var options = CommandLine.Parse(Args("lint --path a.yml --json --strict --binding-check --binding rust"));
        Assert.True(options.Json);
        Assert.True(options.Strict);
        Assert.True(options.BindingCheck);
        Assert.Equal("rust", options.Binding);
    }

    [Fact]
    public void TheBindingDefaultsToThisOne()
    {
        var options = CommandLine.Parse(Args("lint --path a.yml"));
        Assert.Equal("csharp", options.Binding);
        Assert.Equal(ReportFormat.NUnit3, options.Format);
    }

    [Theory]
    [InlineData("", "a verb is needed")]
    [InlineData("frobnicate --path a.yml", "frobnicate")]
    [InlineData("run --path a.yml --nonsense", "--nonsense")]
    [InlineData("run --path", "--path needs a value")]
    [InlineData("run --path a.yml --tags", "--tags needs a value")]
    [InlineData("run --path --json", "--path needs a value")]
    [InlineData("run --path a.yml --format xml", "nunit3 or junit")]
    [InlineData("run --path a.yml --param lonely", "name=value")]
    [InlineData("run --path a.yml --param =x", "name=value")]
    [InlineData("lint", "needs --path")]
    [InlineData("run", "needs --path")]
    [InlineData("list", "needs --path")]
    public void Refusals(string line, string contains)
    {
        var refused = Assert.Throws<CommandLineException>(() => CommandLine.Parse(Args(line)));
        Assert.Contains(contains, refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ActionsNeedsNoPath()
    {
        Assert.Equal(Verb.Actions, CommandLine.Parse(Args("actions")).Verb);
        Assert.True(CommandLine.Parse(Args("actions --json")).Json);
    }

    [Fact]
    public void UsageNamesEveryVerb()
    {
        foreach (var verb in new[] { "lint", "run", "list", "actions" })
        {
            Assert.Contains(verb, CommandLine.Usage, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void AVerbAndAFormatAreSpelledTheWayTheyAreTyped()
    {
        Assert.Equal("lint", CommandLine.Spell(Verb.Lint));
        Assert.Equal("run", CommandLine.Spell(Verb.Run));
        Assert.Equal("list", CommandLine.Spell(Verb.List));
        Assert.Equal("actions", CommandLine.Spell(Verb.Actions));
        Assert.Equal("nunit3", CommandLine.Spell(ReportFormat.NUnit3));
        Assert.Equal("junit", CommandLine.Spell(ReportFormat.JUnit));
    }
}
