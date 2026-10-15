using Bdd.Suite.Extensions;

namespace Bdd.Suite.Tests;

/// <summary>
/// Where the tests find the corpus, its schema and the core catalog, and the
/// extension the corpus is run with.
///
/// The corpus lives at the repository root (conformance/), with its own catalog
/// and schema (conformance/schema); this runtime is runtimes/csharp. dotnet test
/// runs from the build output (artifacts/bin/...), so the repository is found by
/// walking up from the test assembly, then from the working directory, to the
/// folder that holds both conformance/run-manifest.yaml and
/// spec/core.catalog.yaml.
/// </summary>
internal static class Where
{
    /// <summary>This repository's root.</summary>
    public static string Repo { get; } = FindRepo();

    /// <summary>The corpus folder.</summary>
    public static string Corpus => Path.Combine(Repo, "conformance");

    /// <summary>The core catalog every runtime implements exactly.</summary>
    public static string CoreCatalog => Path.Combine(Repo, "spec", "core.catalog.yaml");

    /// <summary>This runtime's folder.</summary>
    public static string Runtime => Path.Combine(Repo, "runtimes", "csharp");

    /// <summary>The example extension's project, which is also its
    /// workspace.</summary>
    public static string Example => Path.Combine(Runtime, "Bdd.Suite.Example");

    private static string FindRepo()
    {
        foreach (var start in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
        {
            string? here = Path.GetFullPath(start);
            while (here is not null)
            {
                if (File.Exists(Path.Combine(here, "conformance", "run-manifest.yaml"))
                    && File.Exists(Path.Combine(here, "spec", "core.catalog.yaml")))
                {
                    return here;
                }
                here = Path.GetDirectoryName(here);
            }
        }
        throw new IOException(
            "the repository (conformance/run-manifest.yaml and spec/core.catalog.yaml) cannot be found from the test assembly or the working directory.");
    }

    /// <summary>
    /// The corpus's context keys (conformance/README.md): the core defines none
    /// beyond timeoutSec and defaults, so the corpus declares the ones its suites
    /// and expression table read, with the values of expressions/context.yaml.
    /// These four names are the corpus's, not the runtime's.
    /// </summary>
    public static Extension CorpusExtension { get; } = new()
    {
        Name = "the corpus",
        ContextKeys = ["cluster", "target", "labId", "apiUrl"],
        OnStart = _ => new RunState
        {
            Context = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["cluster"] = "HOST-CL01",
                ["target"] = "HOST-N1",
                ["labId"] = "lab1",
                ["apiUrl"] = "http://api/api/v1",
            },
        },
    };

    /// <summary>The core and the corpus extension, composed.</summary>
    public static Composite CorpusComposite { get; } = Composite.Compose(CorpusExtension);

    /// <summary>The corpus extension, started, as a run sees it.</summary>
    public static RunExtensions CorpusRun() =>
        new(CorpusComposite, CorpusComposite.Start(new Dictionary<string, string>()));
}
