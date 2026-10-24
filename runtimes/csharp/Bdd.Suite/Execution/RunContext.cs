using Bdd.Suite.Extensions;
using Bdd.Suite.Tracing;

namespace Bdd.Suite.Execution;

/// <summary>
/// What one test process shares (spec/session.md, "run context"): the composed
/// extensions, started once and their state shared by every session; the run's
/// options (tags, parameters, dry run); the trace; whether guarded suites may
/// run; and where the trace is written. <c>suiterun run</c> makes one per
/// invocation; a test process makes one when it starts, usually from its
/// environment.
/// </summary>
public sealed class RunContext
{
    private RunContext(RunOptions options, RunExtensions extensions, Trace trace, bool allowGuarded, string traceFile)
    {
        Options = options;
        Extensions = extensions;
        Trace = trace;
        AllowGuarded = allowGuarded;
        TraceFile = traceFile;
    }

    public RunOptions Options { get; }

    public RunExtensions Extensions { get; }

    public Trace Trace { get; }

    /// <summary>Whether a guarded suite's cases run (spec/session.md, rule 9).
    /// <c>suiterun</c> always allows them; a test process only when
    /// <c>&lt;prefix&gt;ALLOW_GUARDED=1</c>.</summary>
    public bool AllowGuarded { get; }

    /// <summary>Where <see cref="WriteTrace"/> writes; empty for nowhere.</summary>
    public string TraceFile { get; }

    /// <summary>A run context over extensions already started, which is what
    /// <c>suiterun run</c> has: it starts them once for every file it runs.</summary>
    public static RunContext ForRun(RunOptions options, RunExtensions extensions, Trace trace) =>
        new(options, extensions, trace, allowGuarded: true, traceFile: string.Empty);

    /// <summary>Compose the extensions and start them once, with the values of
    /// their options (keyed by flag, <c>--api-url</c>).</summary>
    public static RunContext Create(
        RunOptions options, Composite? composite = null, IReadOnlyDictionary<string, string>? optionValues = null,
        bool allowGuarded = true, string traceFile = "", TextWriter? progress = null)
    {
        var composed = composite ?? Composite.CoreOnly;
        var started = composed.Start(optionValues ?? new Dictionary<string, string>(StringComparer.Ordinal));
        var trace = new Trace();
        // A test framework prints its own case lines, so only the hook and step
        // lines are written; a dry run traces nothing, so it prints nothing.
        if (progress is not null && !options.DryRun)
        {
            trace.Added += new Bdd.Suite.Run.ProgressPrinter(progress).Entry;
        }
        return new RunContext(options, new RunExtensions(composed, started), trace, allowGuarded, traceFile);
    }

    /// <summary>A run context from the process's environment (spec/session.md,
    /// "Inputs a test process takes from the environment").</summary>
    public static RunContext FromEnvironment(params IExtension[] extensions) =>
        FromValues(Environment.GetEnvironmentVariable, extensions);

    /// <summary>
    /// A run context from named values: <c>&lt;prefix&gt;OPTION_&lt;FLAG&gt;</c>,
    /// <c>TAGS</c>, <c>DRY_RUN</c>, <c>ALLOW_GUARDED</c>, <c>TRACE_FILE</c>,
    /// <c>PROGRESS</c> and <c>RECORD_PATH</c>, where the prefix is the extensions' environment prefix.
    /// A test framework's provider passes a lookup over its own run settings
    /// (an MSTest or NUnit <c>.runsettings</c> parameter of the same name) that
    /// falls back to the environment. Suite parameters keep coming from
    /// <c>&lt;prefix&gt;PARAM_&lt;NAME&gt;</c> in the environment, which every
    /// runtime already reads, or from <paramref name="parameters"/>.
    /// </summary>
    public static RunContext FromValues(
        Func<string, string?> lookup, IEnumerable<IExtension> extensions,
        IReadOnlyList<KeyValuePair<string, string>>? parameters = null) =>
        FromValues(lookup, extensions, parameters, Console.Out);

    /// <summary>
    /// <see cref="FromValues(Func{string, string?}, IEnumerable{IExtension}, IReadOnlyList{KeyValuePair{string, string}}?)"/>,
    /// with <c>&lt;prefix&gt;PROGRESS=1</c> writing the run's hook and step lines
    /// (spec/progress.md) to <paramref name="progressWriter"/> as they happen, so a
    /// host that shows a test's output live, such as TAEF, shows what a long case
    /// is doing (docs/test-providers DEC-T15).
    /// </summary>
    public static RunContext FromValues(
        Func<string, string?> lookup, IEnumerable<IExtension> extensions,
        IReadOnlyList<KeyValuePair<string, string>>? parameters, TextWriter progressWriter)
    {
        var composite = Composite.Compose(extensions);
        var prefix = composite.EnvPrefix;
        string Read(string name) => lookup(prefix + name)?.Trim() ?? string.Empty;

        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var option in composite.Options)
        {
            var given = Read("OPTION_" + OptionVariable(option.Flag));
            if (given.Length > 0)
            {
                values[option.Flag] = given;
            }
        }
        var options = new RunOptions
        {
            Tags = Read("TAGS").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
            Params = parameters ?? [],
            DryRun = string.Equals(Read("DRY_RUN"), "1", StringComparison.Ordinal),
            RecordPath = Read("RECORD_PATH"),
        };
        return Create(options, composite, values,
            allowGuarded: string.Equals(Read("ALLOW_GUARDED"), "1", StringComparison.Ordinal),
            traceFile: Read("TRACE_FILE"),
            progress: string.Equals(Read("PROGRESS"), "1", StringComparison.Ordinal) ? progressWriter : null);
    }

    /// <summary>The variable-name part of an option's flag: no leading dashes,
    /// upper case, <c>-</c> as <c>_</c>, so <c>--api-url</c> is <c>API_URL</c>.</summary>
    public static string OptionVariable(string flag) =>
        flag.TrimStart('-').ToUpperInvariant().Replace('-', '_');

    /// <summary>Write the trace to <see cref="TraceFile"/>, when one is named.
    /// A test process calls it when its run ends.</summary>
    public void WriteTrace()
    {
        if (TraceFile.Length == 0)
        {
            return;
        }
        var parent = Path.GetDirectoryName(Path.GetFullPath(TraceFile));
        if (parent is not null)
        {
            Directory.CreateDirectory(parent);
        }
        File.WriteAllText(TraceFile, Trace.ToJson() + "\n");
    }
}
