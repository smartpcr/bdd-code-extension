using System.Globalization;
using System.Text.Json;
using Bdd.Suite.Cli;
using Bdd.Suite.Execution;
using Bdd.Suite.Extensions;
using Bdd.Suite.Reporting;
using Bdd.Suite.Schema;
using Bdd.Suite.Tracing;

namespace Bdd.Suite.Run;

public static partial class Runner
{
    /// <summary>Where `--progress` writes its live lines: standard output
    /// (spec/progress.md). A test may point it elsewhere.</summary>
    public static TextWriter ProgressWriter { get; set; } = Console.Out;

    /// <summary>`list`: the cases a run would select, and nothing else.</summary>
    public static Report List(Options options)
    {
        try
        {
            var lines = new List<string>();
            foreach (var path in SelectedFiles(options))
            {
                var suite = LoadSuite(path);
                foreach (var held in SuiteExpansion.Cases(suite))
                {
                    if (!SuiteExpansion.TagsMatch(SuiteExpansion.CaseTags(suite, held), options.Tags)
                        || !SuiteExpansion.NameMatches(held.Text("name"), options.Names))
                    {
                        continue;
                    }
                    lines.Add(string.Create(CultureInfo.InvariantCulture,
                        $"{Path.GetFileName(path)}  {held.Text("name")}"));
                }
            }
            return new Report { Out = string.Join('\n', lines), Code = Exit.Passed };
        }
        catch (IOException failure)
        {
            return Report.Refused(failure.Message);
        }
    }

    /// <summary>`actions`: what this runtime implements - the core's actions,
    /// wait, and every extension's - which is what a portability check is
    /// answered from.</summary>
    public static Report Actions(Options options, Composite? extensions = null)
    {
        var names = Executor.AllNames(extensions);
        if (!options.Json)
        {
            return new Report { Out = string.Join('\n', names), Code = Exit.Passed };
        }
        var text = JsonSerializer.Serialize(names, new JsonSerializerOptions { WriteIndented = true });
        return new Report { Out = text, Code = Exit.Passed };
    }

    /// <summary>What `--cancel-on-stdin-close` reads to its end: standard input. A
    /// test may point it elsewhere.</summary>
    public static TextReader CancelInput { get; set; } = Console.In;

    /// <summary>`run`: execute every selected case.</summary>
    public static Report RunSuites(Options options, Composite? extensions = null)
    {
        var composite = extensions ?? Composite.CoreOnly;
        using var cancel = new CancellationTokenSource();
        using var watching = WatchForCancel(options, cancel);
        EventWriter? events = null;
        try
        {
            var (_, schemaRoot) = Roots(options);
            var schema = SuiteSchema.Load(schemaRoot);
            var files = SelectedFiles(options);
            // Started once per run and shared by every file, so an extension's
            // state persists across files.
            var run = new RunExtensions(composite, composite.Start(options.ExtensionOptions));

            var trace = new Trace();
            // Live lines while the run goes, for runs that take hours (spec/progress.md),
            // and the step events a host shows a run from (spec/events.md). A dry
            // run runs no step, so it writes no event file.
            var progress = options.Progress ? new ProgressPrinter(ProgressWriter) : null;
            events = options.Events.Length > 0 && !options.DryRun
                ? new EventWriter(options.Events, run.Started.Redact)
                : null;
            var observers = new List<IRunObserver>();
            if (progress is not null)
            {
                observers.Add(progress);
            }
            if (events is not null)
            {
                observers.Add(events);
            }
            var settings = new RunOptions
            {
                Tags = options.Tags,
                Names = options.Names,
                Observer = observers.Count switch { 0 => null, 1 => observers[0], _ => new Observers(observers) },
                Params = options.Params,
                DryRun = options.DryRun,
                RecordPath = Environment.GetEnvironmentVariable(composite.EnvPrefix + "RECORD_PATH") ?? string.Empty,
                Cancel = cancel.Token,
            };
            events?.RunStarted(files);

            var suites = new List<SuiteResult>();
            var lines = new List<string>();
            foreach (var path in files)
            {
                var suite = LoadSuite(path);
                var name = suite.Text("suite") is { Length: > 0 } declared ? declared : Path.GetFileNameWithoutExtension(path);
                SuiteResult result;
                try
                {
                    events?.SuiteStarted(path, name);
                    result = Executor.RunFile(path, suite, schema, settings, trace, run);
                    events?.SuiteFinished(path, name);
                }
                catch (ExpansionException failure)
                {
                    events?.RunFinished("refused", Exit.Refused);
                    return Report.Refused(failure.Message);
                }
                lines.Add(string.Create(CultureInfo.InvariantCulture, $"=== Suite: {Path.GetFileName(path)} ==="));
                foreach (var held in result.Cases)
                {
                    lines.Add(string.Create(CultureInfo.InvariantCulture, $"  [{held.Status,-5}] {held.Name}"));
                }
                suites.Add(result);
            }

            // A cancelled run has not passed, whatever its finished cases did.
            var cancelled = cancel.IsCancellationRequested;
            var failed = Executor.Failed(suites) || cancelled;
            progress?.Summary();

            if (options.TraceFile.Length > 0)
            {
                Write(options.TraceFile, trace.ToJson() + "\n");
                lines.Add("Trace written to " + options.TraceFile);
            }
            if (options.Results.Length > 0)
            {
                // Every text a report carries passes through the extensions'
                // redaction.
                var document = options.Format == ReportFormat.JUnit
                    ? Reports.JUnit(suites, run.Started.Redact)
                    : Reports.NUnit3(suites, run.Started.Redact);
                Write(options.Results, document);
                lines.Add("Results written to " + options.Results);
            }
            lines.Add(cancelled
                ? "The run was cancelled; cleanup, afterEach and teardown ran for the cases that had started."
                : failed
                    ? "One or more tests failed."
                    : options.DryRun
                        ? "Suite validation passed; live tests were not run."
                        : "All selected tests passed.");

            var code = failed ? Exit.Failed : Exit.Passed;
            events?.RunFinished(cancelled ? "cancelled" : failed ? "failed" : "passed", code);
            return new Report { Out = string.Join('\n', lines), Code = code };
        }
        catch (IOException failure)
        {
            events?.RunFinished("refused", Exit.Refused);
            return Report.Refused(failure.Message);
        }
        finally
        {
            events?.Dispose();
        }
    }

    /// <summary>
    /// The watchers `--cancel-on-stdin-close` and `--cancel-file` ask for
    /// (spec/events.md, "Cancel"). Standard input is read to its end on a
    /// background thread; the file is looked for four times a second. Disposing
    /// the result stops the file watch; the reader thread ends with the process.
    /// </summary>
    private static IDisposable WatchForCancel(Options options, CancellationTokenSource cancel)
    {
        if (options.CancelOnStdinClose)
        {
            var input = CancelInput;
            new Thread(() =>
            {
                try
                {
                    while (input.ReadLine() is not null)
                    {
                    }
                }
                catch (Exception failure) when (failure is IOException or ObjectDisposedException)
                {
                    // A reader that breaks has reached its end as surely as one
                    // that closes.
                }
                try
                {
                    cancel.Cancel();
                }
                catch (ObjectDisposedException)
                {
                    // The run ended first.
                }
            })
            { IsBackground = true, Name = "suiterun cancel-on-stdin-close" }.Start();
        }
        if (options.CancelFile.Length == 0)
        {
            return new Timer(_ => { }, null, Timeout.Infinite, Timeout.Infinite);
        }
        var path = Path.GetFullPath(options.CancelFile);
        // A file already there cancels the run before anything starts, not on the
        // timer's first tick.
        if (File.Exists(path))
        {
            cancel.Cancel();
        }
        return new Timer(_ =>
        {
            if (File.Exists(path))
            {
                try
                {
                    cancel.Cancel();
                }
                catch (ObjectDisposedException)
                {
                    // The run ended first.
                }
            }
        }, null, TimeSpan.Zero, TimeSpan.FromMilliseconds(250));
    }

    private static void Write(string path, string text)
    {
        var parent = Path.GetDirectoryName(Path.GetFullPath(path));
        if (parent is not null)
        {
            Directory.CreateDirectory(parent);
        }
        File.WriteAllText(path, text);
    }
}
