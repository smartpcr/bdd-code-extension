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
public sealed class ExecuteCorpusTests
{
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
                var line = new List<string>
                {
                    "run", "--schema-root", corpus.SchemaRoot, "--path", corpus.Path(name), "--trace-file", tracePath,
                };
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
                var started = Stopwatch.StartNew();
                var report = Runner.Execute(options, Where.CorpusComposite);
                var seconds = started.Elapsed.TotalSeconds;
                checked_++;

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

        Assert.Equal(14, checked_);
        Assert.Empty(pending);
        Assert.True(failures.Count == 0,
            $"{failures.Count} of {checked_} entries differ:\n{string.Join('\n', failures)}");
    }
}
