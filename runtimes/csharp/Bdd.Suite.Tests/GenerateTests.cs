using System.Text.Json;
using System.Text.Json.Nodes;
using Bdd.Suite.Cli;
using Bdd.Suite.Model;
using Bdd.Suite.Run;
using Bdd.Suite.Testing;

namespace Bdd.Suite.Tests;

/// <summary>
/// suiterun generate for C# (docs/test-providers, D3, D4): E3's corpus
/// (conformance/generate/) through the manifest, the identifier, guard,
/// detection and config rules, the MSTest golden files, and the writer.
/// </summary>
public sealed class GenerateTests
{
    private static string Canonical(JsonNode? node) => node switch
    {
        JsonObject map => "{" + string.Join(",", map.OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .Select(pair => JsonSerializer.Serialize(pair.Key) + ":" + Canonical(pair.Value))) + "}",
        JsonArray list => "[" + string.Join(",", list.Select(Canonical)) + "]",
        null => "null",
        _ => node.ToJsonString(),
    };

    private static TestsConfig Config(string relative) => TestsConfig.Load(Path.Combine(Where.Corpus, relative));

    [Fact]
    public void E3EveryGenerateEntryOfTheManifest()
    {
        var corpus = Corpus.Find();
        var entries = (corpus.Manifest().List("generate") ?? []).OfType<OrderedMap>()
            .Where(entry => !Corpus.PendingIn(entry, "csharp")).ToList();
        Assert.Equal(2, entries.Count);
        foreach (var entry in entries)
        {
            var report = Runner.Generate(CommandLine.Parse(["generate", "--config", corpus.Path(entry.Text("config")), "--plan"]));
            var exitCode = entry.Value("exitCode") as long? ?? 0;
            Assert.Equal(exitCode, report.Code);
            if (entry.Text("expected") is { Length: > 0 } expected)
            {
                Assert.Equal(
                    Canonical(JsonNode.Parse(File.ReadAllText(corpus.Path(expected)))),
                    Canonical(JsonNode.Parse(report.Out)));
                continue;
            }
            var built = TestPlan.Build(Config(entry.Text("config")));
            Assert.Null(built.Plan);
            var wanted = (entry.List("diagnostics") ?? []).OfType<OrderedMap>()
                .Select(one => $"{one.Text("file")}:{one.Value("line")}:{one.Value("column")} {one.Text("code")}").ToList();
            Assert.Equal(wanted, built.Findings.Select(one => $"{one.File}:{one.Position.Line}:{one.Position.Column} {one.Code}").ToList());
        }
    }

    [Theory]
    [InlineData("places an order", "PlacesAnOrder")]
    [InlineData("rejects a bad quantity [qty=-1]", "RejectsABadQuantityQty1")]
    [InlineData("3 retries", "N3Retries")]
    [InlineData("!!!", "Case")]
    [InlineData("café au lait", "CafAuLait")]
    [InlineData("MSTest_v4", "MSTestV4")]
    public void AnIdentifierIsTheNamesWordsCapitalised(string name, string id) =>
        Assert.Equal(id, Identifiers.Of(name, "Case"));

    [Fact]
    public void ACollisionTakesTheFirstFreeNumberIgnoringCase()
    {
        var ids = new Identifiers(Identifiers.ReservedInSuite);
        Assert.Equal("Setup_2", ids.Take("setup", "Case"));
        Assert.Equal("PlacesAnOrder", ids.Take("places an order", "Case"));
        Assert.Equal("PlacesAnOrder_2", ids.Take("places an order!", "Case"));
        Assert.Equal("PLACESANORDER_3", ids.Take("PLACES AN ORDER", "Case"));
        Assert.Equal("Case", ids.Take("???", "Case"));
        Assert.Equal("Case_2", ids.Take("...", "Case"));
    }

    [Theory]
    [InlineData("core.*", "core.set", true)]
    [InlineData("core.*", "corelike.set", false)]
    [InlineData("wait", "wait", true)]
    [InlineData("wait", "waiting", false)]
    [InlineData("shop.orders.*", "shop.orders.place", true)]
    public void AnOfflinePatternCoversANameOrAPrefix(string pattern, string action, bool covers) =>
        Assert.Equal(covers, TestPlan.Covers(pattern, action));

    [Fact]
    public void TheGuardSeesMetaStepsFromLibrariesAndPolledSteps()
    {
        var plan = TestPlan.Build(Config("generate/bddsuite.tests.yaml")).Plan!;
        var lab = plan.Suites.Single(suite => suite.Name == "lab-work");
        Assert.True(lab.Guarded);
        Assert.Equal(["fixture.state", "inventory.get"], lab.GuardedBy);
        Assert.All(plan.Suites.Where(suite => suite != lab), suite => Assert.False(suite.Guarded));
    }

    [Theory]
    [InlineData("MSTest", "mstest")]
    [InlineData("MSTest.TestFramework;Microsoft.NET.Test.Sdk", "mstest")]
    [InlineData("NUnit;NUnit3TestAdapter", "nunit")]
    [InlineData("xunit.v3", "xunit")]
    [InlineData("Microsoft.NET.Test.Sdk", "")]
    public void TheProviderIsDetectedFromPackageReferences(string packages, string provider) =>
        Assert.Equal(provider, Providers.Detect(packages.Split(';')));

    [Fact]
    public void AProviderTheCSharpRuntimeDoesNotHaveIsRefused()
    {
        var plan = TestPlan.Build(Config("generate/bddsuite.tests.yaml")).Plan!;
        Assert.Contains("not a C# provider", Assert.Throws<TestsConfigException>(() => Generator.Render([plan], "jest")).Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TwoFrameworksAreAChoiceTheProjectMakes()
    {
        Assert.Throws<TestsConfigException>(() => Providers.Detect(["MSTest", "NUnit"]));
        var config = Config("generate/bddsuite.tests.yaml");
        Assert.Equal("nunit", Providers.Choose("nunit", [config], ["MSTest"]));
        Assert.Equal("mstest", Providers.Choose("", [config], ["NUnit"]));
        var unnamed = Config("generate/invalid/bddsuite.tests.yaml");
        Assert.Equal("xunit", Providers.Choose("", [unnamed], ["xunit.v3"]));
        Assert.Throws<TestsConfigException>(() => Providers.Choose("", [unnamed], []));
    }

    [Theory]
    [InlineData("schemaRoot: s", "suites is required")]
    [InlineData("suites: [a.yml]", "schemaRoot is required")]
    [InlineData("suites: [a.yml]\nschemaRoot: s\nprovidr: mstest", "providr is not a config key")]
    [InlineData("suites: [a.yml]\nschemaRoot: s\nprovider: junit", "provider is one of")]
    [InlineData("suites: ['a\\\\b.yml']\nschemaRoot: s", "backslash")]
    [InlineData("suites: [a.yml]\nschemaRoot: s\nofflineActions: ['core.*.x']", "prefix.*")]
    [InlineData("suites: [a.yml]\nschemaRoot: s\noutput: { dir: x }", "output.dir is not an output key")]
    public void AConfigTheSchemaRefusesIsRefused(string yaml, string says)
    {
        var file = Path.Combine(Path.GetTempPath(), "config-" + Guid.NewGuid().ToString("N") + ".yaml");
        File.WriteAllText(file, yaml);
        var refused = Assert.Throws<TestsConfigException>(() => TestsConfig.Load(file));
        Assert.Contains(says, refused.Message, StringComparison.Ordinal);
    }

    /// <summary>Each C# provider's code for the generate corpus, with the
    /// repository's path replaced, equals the committed golden files (T2.4, T3.1,
    /// T3.4). With BDD_UPDATE_GOLDEN=1 the test writes them instead.</summary>
    [Theory]
    [InlineData("mstest")]
    [InlineData("nunit")]
    [InlineData("xunit")]
    public void EachProvidersCodeEqualsTheGoldenFiles(string provider)
    {
        var plan = TestPlan.Build(Config("generate/bddsuite.tests.yaml")).Plan!;
        var files = Generator.Render([plan], provider);
        var golden = Path.Combine(Where.Repo, "runtimes", "csharp", "Bdd.Suite.Tests", "Golden", provider);
        var root = Where.Repo.Replace('\\', '/');
        var update = Environment.GetEnvironmentVariable("BDD_UPDATE_GOLDEN") == "1";
        Directory.CreateDirectory(golden);
        foreach (var file in files)
        {
            var text = file.Text.Replace(root, "<repo>", StringComparison.Ordinal);
            // .golden, not .cs: the test project would compile a .cs file.
            var path = Path.Combine(golden, file.Name + ".golden");
            if (update)
            {
                File.WriteAllText(path, text);
                continue;
            }
            Assert.True(File.Exists(path), $"{file.Name} has no golden file; run the tests with BDD_UPDATE_GOLDEN=1");
            Assert.Equal(File.ReadAllText(path), text);
        }
        Assert.Equal(files.Select(file => file.Name).Order(StringComparer.Ordinal),
            Directory.EnumerateFiles(golden, "*.golden").Select(Path.GetFileNameWithoutExtension).Order(StringComparer.Ordinal));
    }

    [Fact]
    public void TheWriterRewritesOnlyWhatChangedAndRemovesOnlyItsOwnFiles()
    {
        var folder = Path.Combine(Path.GetTempPath(), "generated-" + Guid.NewGuid().ToString("N"));
        var plan = TestPlan.Build(Config("generate/bddsuite.tests.yaml")).Plan!;
        var files = Generator.Render([plan], "mstest");

        var first = Generator.Write(folder, files, check: false);
        Assert.Equal(files.Count, first.Written.Count);
        var stamp = File.GetLastWriteTimeUtc(Path.Combine(folder, files[0].Name));

        Assert.Empty(Generator.Write(folder, files, check: false).Written);
        Assert.Equal(stamp, File.GetLastWriteTimeUtc(Path.Combine(folder, files[0].Name)));
        Assert.Empty(Generator.Write(folder, files, check: true).Stale);

        File.WriteAllText(Path.Combine(folder, "Gone.Suite.g.cs"), CSharpCode.Marker + "\n// a suite that was deleted\n");
        File.WriteAllText(Path.Combine(folder, "Mine.g.cs"), "// someone else's file\n");
        File.AppendAllText(Path.Combine(folder, files[0].Name), "// edited by hand\n");
        var check = Generator.Write(folder, files, check: true);
        Assert.Equal([files[0].Name, "Gone.Suite.g.cs"], check.Stale);

        var again = Generator.Write(folder, files, check: false);
        Assert.Equal([files[0].Name], again.Written);
        Assert.Equal(["Gone.Suite.g.cs"], again.Removed);
        Assert.True(File.Exists(Path.Combine(folder, "Mine.g.cs")));
    }

    [Fact]
    public void TheGenerateCommandLine()
    {
        var options = CommandLine.Parse(["generate", "--config", "a.yaml", "--config", "b.yaml", "--provider", "mstest", "--out", "o", "--packages", "MSTest; NUnit"]);
        Assert.Equal(Verb.Generate, options.Verb);
        Assert.Equal(["a.yaml", "b.yaml"], options.Configs);
        Assert.Equal(["MSTest", "NUnit"], options.Packages);
        Assert.Equal("generate", CommandLine.Spell(Verb.Generate));
        Assert.Throws<CommandLineException>(() => CommandLine.Parse(["generate"]));
        Assert.Throws<CommandLineException>(() => CommandLine.Parse(["generate", "--config", "a", "--plan", "--check"]));
        Assert.Throws<CommandLineException>(() => CommandLine.Parse(["run", "--path", "x", "--config", "a"]));
    }

    [Fact]
    public void CheckSaysWhichFilesAreStaleAndExitsOne()
    {
        var folder = Path.Combine(Path.GetTempPath(), "generated-" + Guid.NewGuid().ToString("N"));
        var config = Path.Combine(Where.Corpus, "generate", "bddsuite.tests.yaml");
        var stale = Runner.Generate(CommandLine.Parse(["generate", "--config", config, "--out", folder, "--check"]));
        Assert.Equal(Exit.Failed, stale.Code);
        Assert.Contains("stale: BddSuite.Tests.Orders.g.cs", stale.Out, StringComparison.Ordinal);
        Assert.Equal(Exit.Passed, Runner.Generate(CommandLine.Parse(["generate", "--config", config, "--out", folder])).Code);
        Assert.Equal(Exit.Passed, Runner.Generate(CommandLine.Parse(["generate", "--config", config, "--out", folder, "--check"])).Code);
        var refused = Runner.Generate(CommandLine.Parse(["generate", "--config", Path.Combine(Where.Corpus, "generate", "invalid", "bddsuite.tests.yaml"), "--out", folder]));
        Assert.Equal(Exit.Refused, refused.Code);
        Assert.Contains("E104", refused.Errors, StringComparison.Ordinal);
    }
}
