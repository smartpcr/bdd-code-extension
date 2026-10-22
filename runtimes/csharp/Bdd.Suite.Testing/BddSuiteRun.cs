using System.Collections.Concurrent;
using Bdd.Suite.Execution;
using Bdd.Suite.Extensions;
using Bdd.Suite.Paths;
using Bdd.Suite.Schema;

namespace Bdd.Suite.Testing;

/// <summary>
/// The run context of one test process (spec/session.md): started once by the
/// generated run hook (<c>[AssemblyInitialize]</c> and its equivalents), shared
/// by every suite, and stopped once at the end, when the trace is written.
/// </summary>
public static class BddSuiteRun
{
    private static readonly ConcurrentDictionary<string, SuiteSchema> Schemas = new(StringComparer.Ordinal);
    private static readonly object Gate = new();
    private static RunContext? current;

    /// <summary>The running run context.</summary>
    public static RunContext Context => current
        ?? throw new InvalidOperationException(
            "No suite run has started: the generated run hook (BddSuite.Run.g.cs) calls BddSuiteRun.Start first.");

    /// <summary>
    /// Start the run: compose and start the extensions, and read the run's
    /// inputs (<c>&lt;prefix&gt;OPTION_*</c>, <c>TAGS</c>, <c>DRY_RUN</c>,
    /// <c>ALLOW_GUARDED</c>, <c>TRACE_FILE</c>, <c>RECORD_PATH</c>) from the test
    /// framework's run settings first and the environment second.
    /// </summary>
    public static void Start(Func<string, string?> settings, params IExtension[] extensions)
    {
        lock (Gate)
        {
            current = RunContext.FromValues(
                name => settings(name) ?? Environment.GetEnvironmentVariable(name), extensions);
        }
    }

    /// <summary>Open one suite for a test class: lint it, then hand its session
    /// to the class, with the method name each case's test has. The paths are
    /// the ones the suite had where the tests were generated; on another
    /// machine the suite is looked for beside the test assembly
    /// (<see cref="RepositoryPaths.Locate"/>).</summary>
    public static SuiteTests Open(string suitePath, string schemaRoot, bool guarded, params (string Method, string Case)[] cases)
    {
        var (suite, schemaDirectory) = RepositoryPaths.Locate(suitePath, schemaRoot, AppContext.BaseDirectory);
        var schema = Schemas.GetOrAdd(Path.GetFullPath(schemaDirectory), SuiteSchema.Load);
        return new SuiteTests(SuiteSession.OpenFile(suite, schema, Context, guarded), cases);
    }

    /// <summary>End the run: write the trace when the run context names a file.</summary>
    public static void Stop()
    {
        lock (Gate)
        {
            current?.WriteTrace();
            current = null;
        }
    }
}
