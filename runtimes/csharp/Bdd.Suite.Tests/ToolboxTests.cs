using Bdd.Suite.Diagnostics;
using Bdd.Suite.Model;
using Bdd.Suite.Paths;
using Bdd.Suite.Schema;
using Bdd.Suite.Text;
using Bdd.Suite.Validation;
using Bdd.Suite.Values;
using Bdd.Suite.Walking;

namespace Bdd.Suite.Tests;

/// <summary>The small shared pieces: paths, values, spelling, diagnostics, the
/// walk and the schema reader.</summary>
public sealed class ToolboxTests
{
    private static OrderedMap Parse(string text) =>
        SuiteDocument.Load(text).Value as OrderedMap
        ?? throw new InvalidOperationException("the text does not hold a mapping");

    /// <summary>A fresh folder for one test, removed afterwards.</summary>
    private static string Scratch(string prefix)
    {
        var directory = Path.Combine(Path.GetTempPath(), prefix + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }

    [Fact]
    public void TheWorkspaceRootIsTheOneHoldingTheSchemaAndTheCorpusIsFound()
    {
        var workspace = Scratch("suiterun-root-");
        try
        {
            var nested = Path.Combine(workspace, "test", "e2e", "suites", "deep");
            Directory.CreateDirectory(nested);
            Assert.Null(RepositoryPaths.FindRoot(nested));
            Directory.CreateDirectory(Path.Combine(workspace, "test", "e2e", "schema"));
            Assert.Equal(Path.GetFullPath(workspace), RepositoryPaths.FindRoot(nested));
            Assert.Equal(Path.Combine(workspace, "test", "e2e", "schema"), RepositoryPaths.SchemaRoot(workspace));
        }
        finally
        {
            Directory.Delete(workspace, true);
        }
        var corpus = Corpus.Find();
        Assert.True(File.Exists(Path.Combine(corpus.SchemaRoot, "suite.schema.json")));
        Assert.True(File.Exists(corpus.Path("run-manifest.yaml")));
    }

    /// <summary>A file with a line of text, its folder made first.</summary>
    private static void Touch(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, "suite: orders\n");
    }

    [Fact]
    public void AGeneratedSuitePathIsFoundBesideTheAssemblyOnAnotherMachine()
    {
        // Built in a workspace with its own layout (BVT/schema, BVT/suites), run
        // from a package that carries schema and suites beside the assembly.
        var built = Scratch("suiterun-built-");
        var package = Scratch("suiterun-package-");
        try
        {
            var builtSchema = Path.Combine(built, "BVT", "schema");
            var builtSuite = Path.Combine(built, "BVT", "suites", "orders.yml");
            Directory.CreateDirectory(builtSchema);
            Touch(builtSuite);

            // On the building machine the generated paths are used as they are.
            Assert.Equal((builtSuite, builtSchema), RepositoryPaths.Locate(builtSuite, builtSchema, package));

            var gone = Path.Combine(built, "elsewhere");
            var goneSchema = Path.Combine(gone, "schema").Replace('\\', '/');
            var goneSuite = Path.Combine(gone, "suites", "orders.yml").Replace('\\', '/');
            var assembly = Path.Combine(package, "bin");
            Directory.CreateDirectory(assembly);

            // Nothing deployed: the generated paths come back, for the error to name.
            Assert.Equal((goneSuite, goneSchema), RepositoryPaths.Locate(goneSuite, goneSchema, assembly));

            // The default layout, test/e2e/{schema,suites}, above the assembly.
            var e2eSchema = Path.Combine(package, "test", "e2e", "schema");
            Directory.CreateDirectory(e2eSchema);
            // A schema without the suite is not taken: the suite must be there too.
            Assert.Equal((goneSuite, goneSchema), RepositoryPaths.Locate(goneSuite, goneSchema, assembly));
            var e2eSuite = Path.Combine(package, "test", "e2e", "suites", "orders.yml");
            Touch(e2eSuite);
            Assert.Equal((e2eSuite, e2eSchema), RepositoryPaths.Locate(goneSuite, goneSchema, assembly));

            // The build's own layout, schema and suites beside the assembly: the
            // nearer folder wins over the test/e2e one above it.
            var flatSchema = Path.Combine(assembly, "schema");
            var flatSuite = Path.Combine(assembly, "suites", "orders.yml");
            Directory.CreateDirectory(flatSchema);
            Touch(flatSuite);
            Assert.Equal((flatSuite, flatSchema), RepositoryPaths.Locate(goneSuite, goneSchema, assembly));

            // A host that cannot say where the assembly runs (an empty folder) gets
            // the generated paths back, for the error to name, instead of a throw.
            Assert.Equal((goneSuite, goneSchema), RepositoryPaths.Locate(goneSuite, goneSchema, string.Empty));
        }
        finally
        {
            Directory.Delete(built, true);
            Directory.Delete(package, true);
        }
    }

    /// <summary>DEC-T14: TAEF's CoreCLR host leaves AppContext.BaseDirectory empty;
    /// the folder of a library deployed beside the test assembly stands in.</summary>
    [Fact]
    public void TheAssemblyFolderFallsBackToALibrarysFolderWhenTheHostGivesNone()
    {
        var library = Path.Combine(Path.GetTempPath(), "pkg", "Bdd.Suite.Testing.dll");
        Assert.Equal("C:/run/", RepositoryPaths.AssemblyDirectory("C:/run/", library));
        Assert.Equal(Path.GetDirectoryName(library), RepositoryPaths.AssemblyDirectory(string.Empty, library));
        Assert.Equal(Path.GetDirectoryName(library), RepositoryPaths.AssemblyDirectory(null, library));
        Assert.Equal(string.Empty, RepositoryPaths.AssemblyDirectory(string.Empty, string.Empty));
    }

    [Theory]
    [InlineData("*.yml", "a.yml", true)]
    [InlineData("*.yml", "a.yaml", false)]
    [InlineData("stage-*.yml", "stage-zero.yml", true)]
    [InlineData("stage-*.yml", "group.yml", false)]
    [InlineData("a?c.yml", "abc.yml", true)]
    [InlineData("a?c.yml", "ac.yml", false)]
    [InlineData("*", "anything", true)]
    [InlineData("*.y*l", "a.yaml", true)]
    [InlineData("exact.yml", "exact.yml", true)]
    // No character class: a pattern that looks like one matches itself.
    [InlineData("[ab].yml", "a.yml", false)]
    [InlineData("[ab].yml", "[ab].yml", true)]
    public void AGlobMatchesOnlyWhatTheOtherBindingsMatch(string pattern, string name, bool want) =>
        Assert.Equal(want, RepositoryPaths.MatchesGlob(pattern, name));

    [Fact]
    public void AGlobComesBackSortedAndAPathThatNamesNothingSaysSo()
    {
        var directory = Path.Combine(Path.GetTempPath(), "suiterun-glob-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            foreach (var name in new[] { "c.yml", "a.yml", "b.yml", "skip.txt" })
            {
                File.WriteAllText(Path.Combine(directory, name), "suite: x\n");
            }
            var found = RepositoryPaths.Resolve("*.yml", directory);
            Assert.Equal(["a.yml", "b.yml", "c.yml"], found.Select(Path.GetFileName));
            Assert.Single(RepositoryPaths.Resolve("b.yml", directory));
            Assert.Throws<IOException>(() => RepositoryPaths.Resolve("nosuchfile.yml", directory));
            Assert.Throws<IOException>(() => RepositoryPaths.Resolve("nosuch*.yml", directory));
        }
        finally
        {
            Directory.Delete(directory, true);
        }
    }

    [Fact]
    public void AValueReadsAsTheTextFourBindingsWrite()
    {
        var held = new OrderedMap();
        held.Set("a", 1L);
        var rows = new (object? Held, string Want)[]
        {
            (null, ""), (true, "true"), (false, "false"), ("x", "x"),
            (3L, "3"), (3.0, "3"), (3.5, "3.5"), (-2L, "-2"),
            (new List<object?> { "a", "b" }, "a, b"),
            (held, "{\"a\":1}"),
        };
        foreach (var (value, want) in rows)
        {
            Assert.Equal(want, Value.Text(value));
        }
    }

    [Fact]
    public void ANumberComesOutOfTextWhenItIsOne()
    {
        Assert.True(Value.TryNumber(3L, out var one));
        Assert.Equal(3, one);
        Assert.True(Value.TryNumber("3.5", out var other));
        Assert.Equal(3.5, other);
        Assert.True(Value.TryNumber(" 4 ", out var spaced));
        Assert.Equal(4, spaced);
        Assert.False(Value.TryNumber("x", out _));
        Assert.False(Value.TryNumber(null, out _));
        Assert.False(Value.TryNumber(true, out _));
    }

    [Fact]
    public void SpellingSuggestsTheNearestAndThenThePrefix()
    {
        Assert.Equal(0, Spelling.Distance("asserts", "Asserts"));
        Assert.Equal(1, Spelling.Distance("assert", "asserts"));
        Assert.Equal(3, Spelling.Distance("timeout", "timeoutSec"));
        Assert.Equal(4, Spelling.Distance("", "four"));
        Assert.Equal(4, Spelling.Distance("four", ""));

        var keys = new[] { "asserts", "captureAs", "timeoutSec", "cleanupTimeoutSec" };
        Assert.Equal("asserts", Spelling.Nearest("assert", keys, 2));
        // Nothing within the distance, so the prefix rule answers.
        Assert.Equal("timeoutSec", Spelling.Nearest("timeout", keys, 2));
        Assert.Equal(string.Empty, Spelling.Nearest("frobnicate", keys, 2));
        Assert.Equal(string.Empty, Spelling.Nearest(string.Empty, keys, 2));
        // A prefix shorter than four characters is not enough to suggest on.
        Assert.Equal(string.Empty, Spelling.Nearest("ti", keys, 0));
    }

    [Fact]
    public void TheSortIsTotalSoTwoBindingsCannotDisagreeByOrdering()
    {
        var findings = new[]
        {
            Diagnostic.Error("E301", "b.yml", Position.At(1, 1), "second file"),
            Diagnostic.Error("E105", "a.yml", Position.At(4, 2), "later in a"),
            Diagnostic.Error("E101", "a.yml", Position.At(4, 2), "same place, earlier code"),
            Diagnostic.Error("E101", "a.yml", Position.At(4, 1), "same line, earlier column"),
            Diagnostic.Error("E101", "a.yml", Position.At(2, 9), "earlier line"),
        };
        Assert.Equal(
            "earlier line|same line, earlier column|same place, earlier code|later in a|second file",
            string.Join('|', Findings.Sorted(findings).Select(finding => finding.Message)));
    }

    [Fact]
    public void TheSameFindingTwiceIsReportedOnce()
    {
        var findings = new[]
        {
            Diagnostic.Error("E103", "a.yml", Position.At(6, 14), "refused"),
            Diagnostic.Error("E103", "a.yml", Position.At(6, 14), "refused"),
            Diagnostic.Error("E103", "a.yml", Position.At(6, 14), "refused differently"),
        };
        Assert.Equal(
            "refused|refused differently",
            string.Join('|', Findings.Sorted(findings).Select(finding => finding.Message)));
    }

    [Fact]
    public void AWarningOnlyFailsUnderStrict()
    {
        var warning = new[] { Diagnostic.Warning("W301", "a.yml", Position.Start, "unread") };
        Assert.False(Findings.Fails(warning, false));
        Assert.True(Findings.Fails(warning, true));
        var failure = new[] { Diagnostic.Error("E101", "a.yml", Position.Start, "typo") };
        Assert.True(Findings.Fails(failure, false));
        Assert.False(Findings.Fails([], true));
    }

    [Fact]
    public void AFindingReadsAsAPlaceAndACodeAndSerialisesAsTheSchemaSays()
    {
        var finding = Diagnostic.Error("E101", "a.yml", Position.At(4, 7), "Unknown key tiemout.")
            .Suggest("Did you mean timeout");
        Assert.StartsWith("a.yml:4:7  E101  Unknown key tiemout.", finding.Human(), StringComparison.Ordinal);
        Assert.Contains("\n    Did you mean timeout", finding.Human(), StringComparison.Ordinal);
        Assert.Equal(string.Empty,
            Diagnostic.Error("E101", "a.yml", Position.Start, "x").Suggest(string.Empty).Suggestion);

        var text = Findings.ToJson([Diagnostic.Warning("W301", "a.yml", Position.At(2, 3), "unread")]);
        foreach (var want in new[] { "\"code\": \"W301\"", "\"severity\": \"warning\"", "\"line\": 2", "\"column\": 3" })
        {
            Assert.Contains(want, text, StringComparison.Ordinal);
        }
        Assert.DoesNotContain("suggestion", text, StringComparison.Ordinal);
        Assert.Equal("[]", Findings.ToJson([]));
    }

    [Fact]
    public void APathIsRelativeWithForwardSlashes()
    {
        var root = Where.Repo;
        var inside = Path.Combine(root, "conformance", "schema", "suite.schema.json");
        Assert.Equal("conformance/schema/suite.schema.json", Findings.RelativePath(inside, root));
    }

    [Fact]
    public void EveryStepIsFoundOnceWithItsPointer()
    {
        var suite = Parse("""
            setup:
              - action: core.noop
            metaSteps:
              - name: m
                steps:
                  - action: core.set
            tests:
              - name: c
                setup:
                  - action: core.record
                steps:
                  - action: core.fail
                cleanup:
                  - action: core.sleep
            """);
        Assert.Equal(
            ["/setup/0", "/metaSteps/0/steps/0", "/tests/0/setup/0", "/tests/0/steps/0", "/tests/0/cleanup/0"],
            Walk.AllSteps(suite).Select(entry => entry.Pointer));
    }

    [Fact]
    public void ANestedStepRunsJustBeforeTheOneThatDrivesIt()
    {
        var suite = Parse("""
            tests:
              - name: c
                steps:
                  - action: wait
                    forStep:
                      action: core.noop
            """);
        var entries = Walk.AllSteps(suite);
        Assert.Equal(2, entries.Count);
        Assert.Equal("/tests/0/steps/0/forStep", entries[0].Pointer);
        Assert.Equal(-1, entries[0].Order);
        Assert.Equal(0, entries[1].Order);
    }

    [Fact]
    public void ABlankEntryInAListIsNotAStepAndTheListsAreNamedForWhatAMessageNeeds()
    {
        var blanks = Parse("tests:\n  - name: c\n    steps:\n      - action: core.noop\n      -\n      - action: core.fail\n");
        var entries = Walk.AllSteps(blanks);
        Assert.Equal(2, entries.Count);
        Assert.Equal("/tests/0/steps/2", entries[1].Pointer);

        var suite = Parse("""
            setup:
              - action: core.noop
            metaSteps:
              - name: m
                steps:
                  - action: core.set
            tests:
              - name: c
                steps:
                  - action: core.fail
                cleanup:
                  - action: core.sleep
            """);
        var lists = Walk.StepLists(suite);
        Assert.Equal(["the suite setup", "meta step m", "case c steps", "case c cleanup"],
            lists.Select(list => list.Name));
        Assert.Equal(0, lists[2].CaseIndex);
        Assert.NotNull(lists[2].Case);
        Assert.Null(lists[0].Case);
        Assert.Equal(-1, lists[0].CaseIndex);
    }

    [Fact]
    public void ATableDeclaresItsColumnsInItsFirstRow()
    {
        var suite = Parse("""
            tests:
              - name: c
                steps:
                  - action: core.noop
                    table:
                      - { node: N1, state: Up }
                      - { node: N2, state: Down }
            """);
        var step = Walk.AllSteps(suite)[0].Step;
        Assert.Equal(["node", "state"], Walk.TableColumns(step.Value("table")));
        Assert.Empty(Walk.TableColumns(null));
        Assert.Empty(Walk.TableColumns("x"));
        Assert.Empty(Walk.AllSteps(Parse("suite: empty\n")));
        Assert.Empty(Walk.StepLists(Parse("suite: empty\n")));
    }

    [Fact]
    public void TheCatalogDeclaresTheActionsTheSuitesCall()
    {
        var schema = SuiteSchema.Load(Corpus.Find().SchemaRoot);
        // The corpus catalog imports the core (core.* and wait) and declares
        // its own fixture actions beside them.
        Assert.True(schema.Has("core.noop"));
        Assert.True(schema.Has("wait"));
        Assert.True(schema.Has("fixture.state"));
        Assert.True(schema.Has("fixture.append"));
        // Declared for the K0 worker-throws entry; csharp implements it in K1,
        // and until then the entry that calls it is pending.
        Assert.True(schema.Has("fixture.throw"));
        Assert.Equal(15, schema.ActionNames.Count);
        Assert.Equal(schema.ActionNames.OrderBy(name => name, StringComparer.Ordinal), schema.ActionNames);

        var invoke = schema.Actions["invoke"];
        Assert.Equal(["powershell"], invoke.Bindings);
        Assert.False(invoke.Interruptible);
        Assert.False(invoke.Deprecated);
        Assert.Contains("script", invoke.Params, StringComparer.Ordinal);
        Assert.Contains("csharp", schema.Actions["core.noop"].Bindings, StringComparer.Ordinal);
        Assert.True(schema.Actions["core.noop"].Interruptible);

        Assert.Contains("equals", schema.AssertOperators, StringComparer.Ordinal);
        Assert.Contains("isNotNull", schema.AssertOperators, StringComparer.Ordinal);
        Assert.DoesNotContain("var", schema.AssertOperators, StringComparer.Ordinal);
        Assert.Contains("captureAs", schema.StepCommonKeys, StringComparer.Ordinal);
        Assert.Contains("timeoutSec", schema.StepCommonKeys, StringComparer.Ordinal);
    }

    [Fact]
    public void AMissingSchemaSaysWhichFileAndWhatToRun()
    {
        var refused = Assert.Throws<IOException>(() =>
            SuiteSchema.Load(Path.Combine(Path.GetTempPath(), "nowhere-at-all")));
        Assert.Contains("Build-Schema.ps1", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AnOverlayPatchesTheCatalogAndTheBranchItGenerated()
    {
        var schema = SuiteSchema.Load(Corpus.Find().SchemaRoot);
        var overlay = SuiteDocument.Load("""
            actions:
              - name: core.noop
                deprecated: true
                params:
                  - name: extra
                    type: string
            """).Value;
        var patched = schema.WithOverlay(overlay);
        Assert.True(patched.Actions["core.noop"].Deprecated);
        Assert.Contains("extra", patched.Actions["core.noop"].Params, StringComparer.Ordinal);
        Assert.NotNull(patched.Defs["step.core.noop"]!["properties"]!["extra"]);
        Assert.False(schema.Actions["core.noop"].Deprecated);
        Assert.Null(schema.Defs["step.core.noop"]!["properties"]!["extra"]);

        var unknown = SuiteDocument.Load("actions:\n  - name: nothing.at.all\n    deprecated: true\n").Value;
        Assert.Throws<IOException>(() => schema.WithOverlay(unknown));
    }

    /// <summary>A schema folder whose suite.schema.json is the corpus's and
    /// whose catalogs are the given files, by name.</summary>
    private static string CatalogWorkspace(params (string Name, string Text)[] files)
    {
        var directory = Scratch("suiterun-catalog-");
        File.Copy(Path.Combine(Corpus.Find().SchemaRoot, "suite.schema.json"), Path.Combine(directory, "suite.schema.json"));
        foreach (var (name, text) in files)
        {
            var path = Path.Combine(directory, name);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, text);
        }
        return directory;
    }

    [Fact]
    public void ACatalogImportsDepthFirstRelativeToTheImportingFile()
    {
        var directory = CatalogWorkspace(
            ("actions.catalog.yaml", "imports: [lib/a.yaml]\nactions:\n  - { name: own.one, bindings: [csharp] }\n"),
            ("lib/a.yaml", "imports: [deeper/b.yaml]\nactions:\n  - { name: a.one, bindings: [csharp], interruptible: false }\n"),
            ("lib/deeper/b.yaml", "actions:\n  - { name: b.one, bindings: [go] }\n"));
        try
        {
            var schema = SuiteSchema.Load(directory);
            Assert.Equal(["a.one", "b.one", "own.one"], schema.ActionNames);
            Assert.False(schema.Actions["a.one"].Interruptible);
            Assert.Equal(["go"], schema.Actions["b.one"].Bindings);
        }
        finally
        {
            Directory.Delete(directory, true);
        }
    }

    [Fact]
    public void ANameDeclaredTwiceIsRefusedNamingBothFiles()
    {
        var directory = CatalogWorkspace(
            ("actions.catalog.yaml", "imports: [other.yaml]\nactions:\n  - { name: same.name }\n"),
            ("other.yaml", "actions:\n  - { name: same.name }\n"));
        try
        {
            var refused = Assert.Throws<IOException>(() => SuiteSchema.Load(directory));
            Assert.Equal(
                $"Action same.name is declared twice: in {Path.Combine(directory, "other.yaml")} and in {Path.Combine(directory, "actions.catalog.yaml")}.",
                refused.Message);
        }
        finally
        {
            Directory.Delete(directory, true);
        }
    }

    [Fact]
    public void AnImportCycleAndAMissingImportAreRefused()
    {
        var cyclic = CatalogWorkspace(
            ("actions.catalog.yaml", "imports: [a.yaml]\n"),
            ("a.yaml", "imports: [b.yaml]\n"),
            ("b.yaml", "imports: [a.yaml]\n"));
        try
        {
            var refused = Assert.Throws<IOException>(() => SuiteSchema.Load(cyclic));
            Assert.StartsWith("Catalog import cycle: ", refused.Message, StringComparison.Ordinal);
            Assert.EndsWith($"{Path.Combine(cyclic, "b.yaml")} -> {Path.Combine(cyclic, "a.yaml")}", refused.Message,
                StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(cyclic, true);
        }

        var missing = CatalogWorkspace(("actions.catalog.yaml", "imports: [nowhere.yaml]\n"));
        try
        {
            var refused = Assert.Throws<IOException>(() => SuiteSchema.Load(missing));
            Assert.Contains("imports nowhere.yaml, which does not exist", refused.Message, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(missing, true);
        }

        var broken = CatalogWorkspace(("actions.catalog.yaml", "imports: [bad.yaml]\n"), ("bad.yaml", "a: [unclosed\n"));
        try
        {
            Assert.Contains("is not YAML", Assert.Throws<IOException>(() => SuiteSchema.Load(broken)).Message,
                StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(broken, true);
        }
    }

    [Fact]
    public void APointerShapeMatchesAnyIndex()
    {
        Assert.True(Structure.IsShaped("/tests/0", "tests", "#"));
        Assert.True(Structure.IsShaped("/tests/12", "tests", "#"));
        Assert.False(Structure.IsShaped("/tests/0/steps", "tests", "#"));
        Assert.False(Structure.IsShaped("/tests/name", "tests", "#"));
        Assert.False(Structure.IsShaped("/metaSteps/0", "tests", "#"));
        Assert.True(Structure.IsShaped("/tests/0/asserts/1", "tests", "#", "asserts", "#"));
        Assert.False(Structure.IsShaped(string.Empty, "tests", "#"));
    }

    [Fact]
    public void ARequiredMessageGivesUpItsNames()
    {
        Assert.Equal(["name"], Structure.QuotedNames("Required properties [\"name\"] are not present"));
        Assert.Equal(["action", "meta"],
            Structure.QuotedNames("Required properties [\"meta\", \"action\"] are not present"));
        Assert.Empty(Structure.QuotedNames("nothing quoted here"));
    }

    [Fact]
    public void TheTwoFindingsAFileThatWillNotParseGets()
    {
        var broken = Structure.Unparseable("a.yml", "it stopped", Position.At(3, 2));
        Assert.Equal("E100", broken.Code);
        Assert.Equal(new Position(3, 2), broken.Position);
        Assert.Contains("it stopped", broken.Message, StringComparison.Ordinal);
        var listy = Structure.NotAMapping("a.yml");
        Assert.Equal("E100", listy.Code);
        Assert.Equal(Position.Start, listy.Position);
    }
}
