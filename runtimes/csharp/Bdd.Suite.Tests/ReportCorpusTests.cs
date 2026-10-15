using System.Globalization;
using Bdd.Suite.Execution;
using Bdd.Suite.Model;
using Bdd.Suite.Reporting;
using Bdd.Suite.Schema;
using Bdd.Suite.Tracing;

namespace Bdd.Suite.Tests;

/// <summary>Three runs in both formats, canonicalised against what the corpus
/// stores.</summary>
public sealed class ReportCorpusTests
{
    [Fact]
    public void ThreeRunsInBothFormatsCanonicaliseToWhatIsStored()
    {
        var corpus = Corpus.Find();
        var manifest = corpus.Manifest();
        var schema = SuiteSchema.Load(corpus.SchemaRoot);
        var reports = manifest.Map("reports") ?? throw new IOException("the manifest declares no reports");

        var failures = new List<string>();
        var checked_ = 0;
        foreach (var raw in reports.List("entries") ?? [])
        {
            if (raw is not OrderedMap entry)
            {
                continue;
            }
            var name = entry.Text("suite");
            var path = corpus.Path(name);
            var suite = SuiteDocument.Load(File.ReadAllText(path)).Value as OrderedMap
                ?? throw new IOException($"{name} does not hold a YAML mapping");

            var tags = entry.Text("tags");
            var options = new RunOptions { Tags = tags.Length > 0 ? tags.Split(',') : [] };
            var trace = new Trace();
            var result = Executor.RunFile(path, suite, schema, options, trace, Where.CorpusRun());
            var suites = new List<SuiteResult> { result };
            var format = entry.Text("format");
            var produced = string.Equals(format, "JUnit", StringComparison.Ordinal)
                ? Reports.JUnit(suites)
                : Reports.NUnit3(suites);
            var stored = File.ReadAllText(corpus.Path(entry.Text("expected")))
                .Replace("\r\n", "\n", StringComparison.Ordinal);
            checked_++;
            var canonical = Canonical.Of(produced);
            if (string.Equals(canonical, stored, StringComparison.Ordinal))
            {
                continue;
            }
            var producedLines = canonical.Split('\n');
            var storedLines = stored.Split('\n');
            var first = 0;
            for (var index = 0; index < Math.Max(producedLines.Length, storedLines.Length); index++)
            {
                if (!string.Equals(At(producedLines, index), At(storedLines, index), StringComparison.Ordinal))
                {
                    first = index;
                    break;
                }
            }
            failures.Add(string.Create(CultureInfo.InvariantCulture,
                $"{name} in {format} differs at line {first + 1}:\n  produced: {At(producedLines, first)}\n  stored:   {At(storedLines, first)}"));
        }

        Assert.Equal(7, checked_);
        Assert.True(failures.Count == 0, string.Join('\n', failures));
    }

    private static string At(string[] lines, int index) => index < lines.Length ? lines[index] : "(nothing)";

    [Fact]
    public void TwoRunsThatDifferOnlyInWhatTheyMeasuredCanonicaliseEqual()
    {
        const string stamped =
            "<test-run id=\"2\" start-time=\"2026-01-01 00:00:00Z\" duration=\"9.000\" total=\"1\"><test-case id=\"0-1\" name=\"c\" result=\"Passed\" duration=\"9.000\"/></test-run>";
        var later = stamped
            .Replace("2026-01-01 00:00:00Z", "2026-06-30 11:22:33Z", StringComparison.Ordinal)
            .Replace("9.000", "0.125", StringComparison.Ordinal)
            .Replace("id=\"2\"", "id=\"7\"", StringComparison.Ordinal);
        Assert.Equal(Canonical.Of(stamped), Canonical.Of(later));
        var changed = stamped.Replace("result=\"Passed\"", "result=\"Failed\"", StringComparison.Ordinal);
        Assert.NotEqual(Canonical.Of(stamped), Canonical.Of(changed));
    }

    [Fact]
    public void AStackTraceAndAFailuresTextAreDroppedAndItsMessageIsNot()
    {
        const string document =
            "<r><test-case name=\"c\"><failure><message>why</message><stack-trace>at somewhere:1</stack-trace></failure></test-case></r>";
        var canonical = Canonical.Of(document);
        Assert.Contains("<message>why</message>", canonical, StringComparison.Ordinal);
        Assert.DoesNotContain("stack-trace", canonical, StringComparison.Ordinal);

        const string junit =
            "<r><testcase name=\"c\"><failure message=\"why\">at somewhere:1</failure></testcase></r>";
        canonical = Canonical.Of(junit);
        Assert.Contains("message=\"why\"", canonical, StringComparison.Ordinal);
        Assert.DoesNotContain("somewhere", canonical, StringComparison.Ordinal);
    }
}
