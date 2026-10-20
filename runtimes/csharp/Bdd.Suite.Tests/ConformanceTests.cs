using Bdd.Suite.Execution;
using Bdd.Suite.Model;
using Bdd.Suite.Walking;

namespace Bdd.Suite.Tests;

/// <summary>
/// One test that says the corpus is fully run by this binding.
///
/// The four family tests beside this one each enumerate the manifest for their
/// own kind. What this one adds is the guarantee that nothing in the manifest
/// falls outside all four: an entry of a kind no test handles, a table or a
/// report nobody reads, or a suite calling an action this binding does not
/// implement would otherwise be skipped in silence, and a corpus that is quietly
/// skipped looks like coverage and is not.
/// </summary>
public sealed class ConformanceTests(Xunit.Abstractions.ITestOutputHelper output)
{
    [Fact]
    public void EveryEntryIsOfAKindThisBindingRuns()
    {
        var corpus = Corpus.Find();
        var manifest = corpus.Manifest();
        var entries = Corpus.Entries(manifest, string.Empty);
        Assert.True(entries.Count >= 50, $"only {entries.Count} entries");

        // A pending entry is neither run nor counted (conformance/README.md),
        // whatever its kind: one of a kind this binding does not run yet waits
        // for the stage that adds it, as any other pending entry does.
        var pending = entries.Where(entry => Corpus.PendingIn(entry, "csharp")).ToList();
        var runnable = entries.Where(entry => !Corpus.PendingIn(entry, "csharp")).ToList();
        Corpus.ReportPending(output, "entries", pending
            .Select(entry => $"{entry.Text("kind")} {entry.Text("suite")}").ToList());

        var unknown = runnable
            .Select(entry => entry.Text("kind"))
            .Where(kind => !string.Equals(kind, "validate", StringComparison.Ordinal)
                && !string.Equals(kind, "execute", StringComparison.Ordinal))
            .Select(kind => kind.Length == 0 ? "(none)" : kind)
            .ToList();
        Assert.True(unknown.Count == 0,
            $"the manifest holds entries of kinds no test here runs: {string.Join(", ", unknown)}");
        // The counts after the move (conformance/rename.json): the lifecycle and
        // E214 entries went back to the product that owns those rules.
        Assert.Equal(41, runnable.Count(entry => string.Equals(entry.Text("kind"), "validate", StringComparison.Ordinal)));
        Assert.Equal(14, runnable.Count(entry => string.Equals(entry.Text("kind"), "execute", StringComparison.Ordinal)));
    }

    [Fact]
    public void EveryFileUnderValidateAndExecuteIsAnEntryOrSupport()
    {
        var corpus = Corpus.Find();
        var manifest = corpus.Manifest();
        var known = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in Corpus.Entries(manifest, string.Empty))
        {
            foreach (var key in new[] { "suite", "expectation", "catalogOverlay", "progress" })
            {
                if (entry.Text(key) is { Length: > 0 } name)
                {
                    known.Add(name);
                }
            }
        }
        foreach (var raw in manifest.List("support") ?? [])
        {
            if (raw is string name)
            {
                known.Add(name);
            }
        }
        var stray = new List<string>();
        foreach (var folder in new[] { "validate", "execute" })
        {
            foreach (var file in System.IO.Directory.EnumerateFiles(corpus.Path(folder), "*", SearchOption.AllDirectories))
            {
                var relative = Path.GetRelativePath(corpus.Directory, file).Replace('\\', '/');
                if (!known.Contains(relative))
                {
                    stray.Add(relative);
                }
            }
        }
        Assert.True(stray.Count == 0, $"files no entry names: {string.Join(", ", stray)}");
    }

    [Fact]
    public void EveryFileTheManifestNamesIsThere()
    {
        var corpus = Corpus.Find();
        var manifest = corpus.Manifest();
        var named = new List<string>();
        foreach (var entry in Corpus.Entries(manifest, string.Empty))
        {
            foreach (var key in new[] { "suite", "expectation", "catalogOverlay", "progress" })
            {
                var name = entry.Text(key);
                if (name.Length > 0)
                {
                    named.Add(name);
                }
            }
        }
        foreach (var raw in manifest.List("support") ?? [])
        {
            if (raw is string name)
            {
                named.Add(name);
            }
        }
        foreach (var raw in manifest.List("lists") ?? [])
        {
            if (raw is OrderedMap list && list.Text("suite") is { Length: > 0 } name)
            {
                named.Add(name);
            }
        }
        foreach (var raw in manifest.List("tables") ?? [])
        {
            if (raw is not OrderedMap table)
            {
                continue;
            }
            foreach (var key in new[] { "context", "cases" })
            {
                var name = table.Text(key);
                if (name.Length > 0)
                {
                    named.Add(name);
                }
            }
        }
        if (manifest.Map("reports") is { } reports)
        {
            var definition = reports.Text("definition");
            if (definition.Length > 0)
            {
                named.Add(definition);
            }
            foreach (var raw in reports.List("entries") ?? [])
            {
                if (raw is not OrderedMap entry)
                {
                    continue;
                }
                foreach (var key in new[] { "suite", "expected" })
                {
                    var name = entry.Text(key);
                    if (name.Length > 0)
                    {
                        named.Add(name);
                    }
                }
            }
        }

        var missing = named.Where(name => !File.Exists(corpus.Path(name))).ToList();
        // An entry's schemaRoot names a folder, not a file.
        missing.AddRange(Corpus.Entries(manifest, string.Empty)
            .Select(entry => entry.Text("schemaRoot"))
            .Where(folder => folder.Length > 0 && !System.IO.Directory.Exists(corpus.Path(folder))));
        Assert.True(missing.Count == 0,
            $"the manifest names files that are not there: {string.Join(", ", missing)}");
    }

    [Fact]
    public void EveryActionTheExecuteCorpusCallsIsOneThisBindingImplements()
    {
        var corpus = Corpus.Find();
        var manifest = corpus.Manifest();
        // The core, wait and the corpus extension's fixture.append.
        var implemented = Executor.AllNames(Where.CorpusComposite).ToHashSet(StringComparer.Ordinal);

        var called = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in Corpus.Entries(manifest, "execute").Where(entry => !Corpus.PendingIn(entry, "csharp")))
        {
            Corpus.CollectActions(corpus.Yaml(entry.Text("suite")), called);
        }
        Assert.True(called.Count > 0, "the execute corpus calls no actions at all");

        var missing = called.Where(name => !implemented.Contains(name)).OrderBy(name => name, StringComparer.Ordinal).ToList();
        Assert.True(missing.Count == 0,
            $"the execute corpus calls actions this binding does not implement: {string.Join(", ", missing)}");
    }

    [Fact]
    public void TheCoreCatalogsCsharpSetIsExactlyTheRegisteredNames()
    {
        // Every core action the core catalog lists for csharp is registered, and
        // nothing else is, so a core action cannot be implemented without being
        // declared or declared without being implemented. A workspace's own
        // actions come from extensions.
        var catalog = SuiteDocument.Load(File.ReadAllText(Where.CoreCatalog)).Value as OrderedMap
            ?? throw new IOException("the core catalog does not hold a YAML mapping");
        var declared = (catalog.List("actions") ?? [])
            .OfType<OrderedMap>()
            .Where(action => (action.List("bindings") ?? []).Contains("csharp"))
            .Select(action => action.Text("name"))
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();
        var registered = Executor.AllNames();
        Assert.Equal(declared, registered);
        Assert.Equal(["core.fail", "core.noop", "core.record", "core.set", "core.sleep", "wait"], registered);
    }

    [Fact]
    public void TheWalkReachesEveryStepListOfACorpusSuite()
    {
        var corpus = Corpus.Find();
        var suite = corpus.Yaml("execute/hooks.yml");
        var lists = Corpus.StepLists(suite);
        Assert.NotEmpty(lists);
        Assert.Contains(lists, list => list.Name.StartsWith("the suite ", StringComparison.Ordinal));
        Assert.Contains(lists, list => list.Name.StartsWith("case ", StringComparison.Ordinal));
        Assert.NotEmpty(Walk.AllSteps(suite));
    }
}
