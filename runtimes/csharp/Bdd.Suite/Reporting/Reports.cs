using System.Globalization;
using System.Text;
using Bdd.Suite.Execution;
using Bdd.Suite.Tracing;

namespace Bdd.Suite.Reporting;

/// <summary>
/// The two reports a run writes.
///
/// The same documents the other runtimes write, so that they canonicalise
/// equal by the rules in conformance/report/canonicalise.md. The timestamps and durations
/// stay in the shipped output: a report a person reads wants them, and the
/// canonical form is what drops them for a comparison.
/// </summary>
public static class Reports
{
    /// <summary>XML text with the five characters that cannot appear raw
    /// replaced.</summary>
    internal static string Escape(string text) => text
        .Replace("&", "&amp;", StringComparison.Ordinal)
        .Replace("<", "&lt;", StringComparison.Ordinal)
        .Replace(">", "&gt;", StringComparison.Ordinal)
        .Replace("\"", "&quot;", StringComparison.Ordinal)
        .Replace("'", "&apos;", StringComparison.Ordinal);

    private static (int Total, int Passed, int Failed, int Skipped) Counts(IReadOnlyList<CaseResult> cases)
    {
        var passed = cases.Count(held => string.Equals(held.Status, Status.Passed, StringComparison.Ordinal));
        var failed = cases.Count(held =>
            string.Equals(held.Status, Status.Failed, StringComparison.Ordinal)
            || string.Equals(held.Status, Status.Error, StringComparison.Ordinal));
        var skipped = cases.Count(held => string.Equals(held.Status, Status.Skipped, StringComparison.Ordinal));
        return (cases.Count, passed, failed, skipped);
    }

    private static string ResultWord(string status) => status switch
    {
        Status.Passed => "Passed",
        Status.Skipped => "Skipped",
        _ => "Failed",
    };

    /// <summary>The time a report stamps itself with. Dropped by the canonical
    /// form, so its only job is to be a legal timestamp.</summary>
    private static string Stamp() =>
        DateTime.UtcNow.ToString("yyyy-MM-dd HH:mm:ssZ", CultureInfo.InvariantCulture);

    private static string Trim(string output) => output.TrimEnd('\n', '\r', '\t', ' ');

    /// <summary>The NUnit 3 document. Every text it carries passes through
    /// redact first, which is how an extension hides a secret.</summary>
    public static string NUnit3(IReadOnlyList<SuiteResult> suites, Func<string, string>? redact = null)
    {
        string X(string text) => Escape(redact is null ? text : redact(text));
        var all = suites.SelectMany(suite => suite.Cases).ToList();
        var (total, passed, failed, skipped) = Counts(all);
        var duration = all.Sum(held => held.DurationSec);
        var now = Stamp();
        var overall = failed > 0 ? "Failed" : "Passed";

        var out_ = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
        out_.Append(CultureInfo.InvariantCulture,
            $"<test-run id=\"2\" testcasecount=\"{total}\" result=\"{overall}\" total=\"{total}\" passed=\"{passed}\" failed=\"{failed}\" inconclusive=\"0\" skipped=\"{skipped}\" asserts=\"0\" engine-version=\"1.0\" clr-version=\"csharp\" start-time=\"{now}\" end-time=\"{now}\" duration=\"{duration.ToString("F3", CultureInfo.InvariantCulture)}\">\n");
        var suiteId = 1000;
        var caseId = 2000;
        foreach (var suite in suites)
        {
            suiteId++;
            var counts = Counts(suite.Cases);
            var suiteDuration = suite.Cases.Sum(held => held.DurationSec);
            var result = counts.Failed > 0 ? "Failed" : "Passed";
            var name = X(suite.Name);
            out_.Append(CultureInfo.InvariantCulture,
                $"  <test-suite type=\"TestFixture\" id=\"0-{suiteId}\" name=\"{name}\" fullname=\"{name}\" classname=\"{name}\" runstate=\"Runnable\" testcasecount=\"{counts.Total}\" result=\"{result}\" start-time=\"{now}\" end-time=\"{now}\" duration=\"{suiteDuration.ToString("F3", CultureInfo.InvariantCulture)}\" total=\"{counts.Total}\" passed=\"{counts.Passed}\" failed=\"{counts.Failed}\" inconclusive=\"0\" skipped=\"{counts.Skipped}\" asserts=\"0\">\n");
            foreach (var held in suite.Cases)
            {
                caseId++;
                var caseName = X(held.Name);
                out_.Append(CultureInfo.InvariantCulture,
                    $"    <test-case id=\"0-{caseId}\" name=\"{caseName}\" fullname=\"{name}.{caseName}\" methodname=\"{caseName}\" classname=\"{name}\" runstate=\"Runnable\" result=\"{ResultWord(held.Status)}\" start-time=\"{now}\" end-time=\"{now}\" duration=\"{held.DurationSec.ToString("F3", CultureInfo.InvariantCulture)}\" asserts=\"0\">\n");
                if (string.Equals(held.Status, Status.Failed, StringComparison.Ordinal)
                    || string.Equals(held.Status, Status.Error, StringComparison.Ordinal))
                {
                    out_.Append("      <failure>\n");
                    out_.Append(CultureInfo.InvariantCulture, $"        <message>{X(held.Message)}</message>\n");
                    out_.Append("      </failure>\n");
                }
                else if (string.Equals(held.Status, Status.Skipped, StringComparison.Ordinal))
                {
                    out_.Append("      <reason>\n");
                    out_.Append(CultureInfo.InvariantCulture, $"        <message>{X(held.Message)}</message>\n");
                    out_.Append("      </reason>\n");
                }
                if (held.Output.Length > 0)
                {
                    out_.Append(CultureInfo.InvariantCulture, $"      <output>{X(Trim(held.Output))}</output>\n");
                }
                out_.Append("    </test-case>\n");
            }
            out_.Append("  </test-suite>\n");
        }
        out_.Append("</test-run>\n");
        return out_.ToString();
    }

    /// <summary>The JUnit document. Every text it carries passes through
    /// redact first, which is how an extension hides a secret.</summary>
    public static string JUnit(IReadOnlyList<SuiteResult> suites, Func<string, string>? redact = null)
    {
        string X(string text) => Escape(redact is null ? text : redact(text));
        var out_ = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<testsuites>\n");
        foreach (var suite in suites)
        {
            var counts = Counts(suite.Cases);
            var name = X(suite.Name);
            out_.Append(CultureInfo.InvariantCulture,
                $"  <testsuite name=\"{name}\" tests=\"{counts.Total}\" failures=\"{counts.Failed}\" skipped=\"{counts.Skipped}\">\n");
            foreach (var held in suite.Cases)
            {
                var caseName = X(held.Name);
                out_.Append(CultureInfo.InvariantCulture,
                    $"    <testcase name=\"{caseName}\" classname=\"{name}\" time=\"{held.DurationSec.ToString("F3", CultureInfo.InvariantCulture)}\">\n");
                if (string.Equals(held.Status, Status.Failed, StringComparison.Ordinal)
                    || string.Equals(held.Status, Status.Error, StringComparison.Ordinal))
                {
                    out_.Append(CultureInfo.InvariantCulture,
                        $"      <failure message=\"{X(held.Message)}\"></failure>\n");
                }
                else if (string.Equals(held.Status, Status.Skipped, StringComparison.Ordinal))
                {
                    out_.Append(CultureInfo.InvariantCulture,
                        $"      <skipped message=\"{X(held.Message)}\"></skipped>\n");
                }
                out_.Append(CultureInfo.InvariantCulture,
                    $"      <system-out>{X(Trim(held.Output))}</system-out>\n");
                out_.Append("    </testcase>\n");
            }
            out_.Append("  </testsuite>\n");
        }
        out_.Append("</testsuites>\n");
        return out_.ToString();
    }
}
