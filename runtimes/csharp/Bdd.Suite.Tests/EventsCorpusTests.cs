using System.Text.Json;
using System.Text.Json.Nodes;
using Bdd.Suite.Cli;
using Bdd.Suite.Model;
using Bdd.Suite.Run;
using Json.Schema;
using Stopwatch = System.Diagnostics.Stopwatch;

namespace Bdd.Suite.Tests;

/// <summary>
/// The step-event corpus (conformance/events, spec/events.md): each entry's run
/// writes, after masking, exactly the events its expectation holds, and every
/// line validates against spec/events.schema.json. With
/// <c>BDD_SUITE_UPDATE_EVENTS=1</c> the expectations are written instead of
/// compared, for a reviewer to read before committing.
/// </summary>
public sealed class EventsCorpusTests(Xunit.Abstractions.ITestOutputHelper output)
{
    private static readonly Corpus Corpus = Corpus.Find();

    /// <summary>The fields a run is free to differ in: when, how long, and the
    /// wording of a message or a detail (conformance/README.md).</summary>
    private static readonly string[] Masked = ["at", "started", "durationMs", "message", "detail"];

    internal static JsonSchema EventSchema { get; } =
        JsonSchema.FromText(File.ReadAllText(Path.Combine(Where.Repo, "spec", "events.schema.json")));

    /// <summary>Every line of an event file, each checked against the
    /// schema.</summary>
    internal static List<JsonObject> ReadEvents(string path)
    {
        var events = new List<JsonObject>();
        foreach (var line in File.ReadAllLines(path))
        {
            if (line.Length == 0)
            {
                continue;
            }
            var node = JsonNode.Parse(line)!.AsObject();
            var verdict = EventSchema.Evaluate(node, new EvaluationOptions { OutputFormat = OutputFormat.List });
            Assert.True(verdict.IsValid, $"{path}: not an event: {line}");
            events.Add(node);
        }
        return events;
    }

    /// <summary>One event as the expectation holds it.</summary>
    private static string Masking(JsonObject node)
    {
        foreach (var field in Masked)
        {
            node.Remove(field);
        }
        if (node["file"] is JsonValue file)
        {
            node["file"] = Relative(file.GetValue<string>());
        }
        if (node["files"] is JsonArray files)
        {
            node["files"] = new JsonArray(files.Select(one => (JsonNode?)Relative(one!.GetValue<string>())).ToArray());
        }
        if (node["step"] is JsonObject step && step["file"] is JsonValue stepFile)
        {
            step["file"] = Relative(stepFile.GetValue<string>());
        }
        return node.ToJsonString();
    }

    private static string Relative(string path) =>
        Path.GetRelativePath(Corpus.Directory, Path.GetFullPath(path)).Replace('\\', '/');

    [Fact]
    public void EveryEventsEntry()
    {
        var manifest = Corpus.Yaml("events/manifest.yaml");
        if (!(manifest.List("runtimes") ?? []).Contains("csharp"))
        {
            output.WriteLine("the events corpus does not list csharp");
            return;
        }
        var update = Environment.GetEnvironmentVariable("BDD_SUITE_UPDATE_EVENTS") == "1";
        var scratch = Directory.CreateTempSubdirectory("bdd-events-").FullName;
        var wrong = new List<string>();
        try
        {
            foreach (var raw in manifest.List("entries") ?? [])
            {
                var entry = (OrderedMap)raw!;
                var suite = entry.Text("suite");
                var eventsPath = Path.Combine(scratch, Path.GetFileNameWithoutExtension(suite) + ".jsonl");
                List<string> line = ["run", "--schema-root", Corpus.SchemaRoot, "--path", Corpus.Path(suite), "--events", eventsPath];
                Timer? canceller = null;
                if (entry.Value("cancelAfterSec") is long after)
                {
                    var cancelFile = Path.Combine(scratch, "cancel-" + Path.GetFileNameWithoutExtension(suite));
                    line.AddRange(["--cancel-file", cancelFile]);
                    canceller = new Timer(_ => File.WriteAllText(cancelFile, "cancel"), null, TimeSpan.FromSeconds(after), Timeout.InfiniteTimeSpan);
                }
                var clock = Stopwatch.StartNew();
                var report = Runner.Execute(CommandLine.Parse(line, Where.CorpusComposite), Where.CorpusComposite);
                clock.Stop();
                canceller?.Dispose();

                if (entry.Value("exitCode") is long code && report.Code != code)
                {
                    wrong.Add($"{suite}: exit {report.Code}, expected {code}\n{report.Out}\n{report.Errors}");
                }
                if (entry.Value("withinSec") is long within && clock.Elapsed.TotalSeconds > within)
                {
                    wrong.Add($"{suite}: took {clock.Elapsed.TotalSeconds:F1}s, more than {within}s");
                }
                var got = ReadEvents(eventsPath).Select(Masking).ToList();
                var expectation = Corpus.Path(entry.Text("events"));
                if (update)
                {
                    File.WriteAllText(expectation, string.Join('\n', got) + "\n");
                    output.WriteLine($"wrote {expectation}");
                    continue;
                }
                var wanted = File.ReadAllLines(expectation).Where(text => text.Length > 0).ToList();
                if (!got.SequenceEqual(wanted))
                {
                    wrong.Add($"{suite}: events differ.\nGot:\n  {string.Join("\n  ", got)}\nExpected:\n  {string.Join("\n  ", wanted)}");
                }
            }
        }
        finally
        {
            Directory.Delete(scratch, recursive: true);
        }
        Assert.True(wrong.Count == 0, string.Join("\n\n", wrong));
    }
}
