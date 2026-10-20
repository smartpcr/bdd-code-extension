using System.Diagnostics;
using System.Globalization;
using Bdd.Suite.Cli;
using Bdd.Suite.Model;
using Bdd.Suite.Run;
using Bdd.Suite.Values;

namespace Bdd.Suite.Tests;

/// <summary>
/// The execute corpus: the trace a run must emit, and the code it must exit
/// with.
///
/// A report says which cases passed; only a trace says in which order the phases
/// ran, which step a guard skipped and which row of a table failed.
/// </summary>
[Collection(ProgressWriterCollection.Name)]
public sealed class ExecuteCorpusTests(Xunit.Abstractions.ITestOutputHelper output)
{
    /// <summary>Progress lines with what the contract leaves free masked: the
    /// failure text and the durations (spec/progress.md).</summary>
    private static List<string> Masked(IEnumerable<string> lines) => lines
        .Select(line => System.Text.RegularExpressions.Regex.Replace(line, @"^(    failure: ).*$", "$1*"))
        .Select(line => System.Text.RegularExpressions.Regex.Replace(line, @"\(\d+s\)", "(*s)"))
        .ToList();

    /// <summary>One trace as one comparable line per entry.</summary>
    private static List<string> AsLines(object? trace) =>
        (trace as List<object?> ?? [])
        .OfType<OrderedMap>()
        .Select(entry => string.Create(CultureInfo.InvariantCulture,
            $"{entry.Text("phase")} | {entry.Text("case")} | {entry.Text("step")} | {entry.Text("action")} | {entry.Text("status")} | {entry.Text("reason")}"))
        .ToList();

    [Fact]
    public void EveryExecuteEntry()
    {
        var corpus = Corpus.Find();
        var manifest = corpus.Manifest();
        var scratch = Path.Combine(Path.GetTempPath(),
            "suiterun-execute-" + Environment.ProcessId.ToString(CultureInfo.InvariantCulture));
        Directory.CreateDirectory(scratch);

        var failures = new List<string>();
        var checked_ = 0;
        var pending = new List<string>();
        try
        {
            foreach (var entry in Corpus.Entries(manifest, "execute"))
            {
                var name = entry.Text("suite");
                if (Corpus.PendingIn(entry, "csharp"))
                {
                    pending.Add(name);
                    continue;
                }
                var stem = Path.GetFileNameWithoutExtension(name);
                var tracePath = Path.Combine(scratch, stem + ".trace.json");
                var schemaRoot = entry.Text("schemaRoot");
                var line = new List<string>
                {
                    "run", "--schema-root", schemaRoot.Length > 0 ? corpus.Path(schemaRoot) : corpus.SchemaRoot,
                    "--path", corpus.Path(name), "--trace-file", tracePath,
                };
                var names = entry.Text("names");
                if (names.Length > 0)
                {
                    line.Add("--name");
                    line.Add(names);
                }
                var transcript = entry.Text("progress");
                if (transcript.Length > 0)
                {
                    line.Add("--progress");
                }
                var tags = entry.Text("tags");
                if (tags.Length > 0)
                {
                    line.Add("--tags");
                    line.Add(tags);
                }
                if (entry.Map("params") is { } given)
                {
                    foreach (var param in given.Keys)
                    {
                        line.Add("--param");
                        line.Add(param + "=" + Value.Text(given.Value(param)));
                    }
                }

                // Exactly what a consumer's own suiterun does: the runtime with
                // the corpus extension (its context keys).
                var options = CommandLine.Parse(line, Where.CorpusComposite);
                var progress = new StringWriter();
                var standard = Runner.ProgressWriter;
                Runner.ProgressWriter = progress;
                var started = Stopwatch.StartNew();
                Report report;
                try
                {
                    report = Runner.Execute(options, Where.CorpusComposite);
                }
                finally
                {
                    Runner.ProgressWriter = standard;
                }
                var seconds = started.Elapsed.TotalSeconds;
                checked_++;

                var printed = progress.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(text => text.TrimEnd('\r'));
                if (transcript.Length > 0)
                {
                    var wanted = File.ReadAllLines(corpus.Path(transcript));
                    var got = Masked(printed);
                    if (!got.SequenceEqual(wanted))
                    {
                        failures.Add($"{name} progress differs.\nPrinted:\n  {string.Join("\n  ", got)}\nExpected:\n  {string.Join("\n  ", wanted)}");
                    }
                }
                else if (printed.Any())
                {
                    failures.Add($"{name} printed progress lines without --progress");
                }

                var expectation = corpus.Json(entry.Text("expectation"));
                var expectedCode = expectation.Value("exitCode") as long? ?? 0L;
                if (report.Code != expectedCode)
                {
                    failures.Add(string.Create(CultureInfo.InvariantCulture,
                        $"{name} exits {report.Code}; the expectation says {expectedCode}. It said:\n{report.Out}\n{report.Errors}"));
                    continue;
                }
                if (Value.TryNumber(expectation.Value("maxSeconds"), out var most) && most > 0 && seconds >= most)
                {
                    failures.Add(string.Create(CultureInfo.InvariantCulture,
                        $"{name} took {seconds:F1}s; it has to finish inside {most}s or the limit was waited out"));
                }
                if (!File.Exists(tracePath))
                {
                    failures.Add(string.Create(CultureInfo.InvariantCulture, $"{name} wrote no trace"));
                    continue;
                }
                using var written = System.Text.Json.JsonDocument.Parse(File.ReadAllText(tracePath));
                var produced = AsLines(Corpus.FromJson(written.RootElement));
                var expected = AsLines(expectation.Value("trace"));
                if (!string.Equals(string.Join('\n', produced), string.Join('\n', expected), StringComparison.Ordinal))
                {
                    failures.Add(string.Create(CultureInfo.InvariantCulture,
                        $"{name} trace differs.\nProduced:\n  {string.Join("\n  ", produced)}\nExpected:\n  {string.Join("\n  ", expected)}"));
                }
            }
        }
        finally
        {
            try
            {
                Directory.Delete(scratch, true);
            }
            catch (IOException)
            {
                // A scratch directory that will not go is not a test failure.
            }
        }

        Corpus.ReportPending(output, "execute", pending);
        Assert.Equal(20, checked_);
        Assert.True(failures.Count == 0,
            $"{failures.Count} of {checked_} entries differ:\n{string.Join('\n', failures)}");
    }
}
