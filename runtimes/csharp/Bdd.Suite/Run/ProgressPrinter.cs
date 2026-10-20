using System.Globalization;
using Bdd.Suite.Execution;
using Bdd.Suite.Tracing;

namespace Bdd.Suite.Run;

/// <summary>
/// The live lines `run --progress` prints while a run is going (spec/progress.md).
///
/// A run of many lab suites takes hours, and the people and tools watching it
/// need to know which case is running and how the finished ones went before the
/// report is written at the end. The lines use the shape TAEF's console output
/// has, because existing lab tooling already parses it:
///
///       suite-setup   step 1 (core.record) passed
///   StartGroup: orders::place-an-order
///       step          when the order is placed (shop.order) passed
///   EndGroup: orders::place-an-order [Passed] (3s)
///   Summary: Total=1, Passed=1, Failed=0, Blocked=0, Not Run=0, Skipped=0
///
/// Only selected cases are counted: a case the tag or name filter left out was
/// never part of this run.
/// </summary>
public sealed class ProgressPrinter(TextWriter writer) : IRunObserver
{
    private readonly object gate = new();
    private int passed;
    private int failed;
    private int skipped;

    public void CaseStarted(string suite, string caseName) =>
        Write(string.Create(CultureInfo.InvariantCulture, $"StartGroup: {suite}::{caseName}"));

    public void CaseFinished(string suite, CaseResult result)
    {
        var verdict = result.Status switch
        {
            Status.Passed => "Passed",
            Status.Skipped => "Skipped",
            _ => "Failed",
        };
        lock (this.gate)
        {
            switch (verdict)
            {
                case "Passed":
                    this.passed++;
                    break;
                case "Skipped":
                    this.skipped++;
                    break;
                default:
                    this.failed++;
                    break;
            }
        }
        if (verdict == "Failed" && result.Message.Length > 0)
        {
            Write("    failure: " + result.Message.ReplaceLineEndings(" "));
        }
        Write(string.Create(CultureInfo.InvariantCulture,
            $"EndGroup: {suite}::{result.Name} [{verdict}] ({result.DurationSec:0}s)"));
    }

    /// <summary>One line per trace entry other than a case's result, so the last
    /// line of a log says what a long case is doing.</summary>
    public void Entry(TraceEntry entry)
    {
        if (entry.Phase == Phase.Case)
        {
            return;
        }
        // A step label written with a Gherkin keyword already ends in "(action)".
        var action = entry.Action.Length > 0 && !entry.Step.Contains("(" + entry.Action + ")", StringComparison.Ordinal)
            ? " (" + entry.Action + ")"
            : string.Empty;
        var reason = entry.Reason.Length > 0 ? " [" + entry.Reason + "]" : string.Empty;
        Write(string.Create(CultureInfo.InvariantCulture,
            $"    {entry.Phase,-13} {entry.Step}{action} {entry.Status}{reason}"));
    }

    /// <summary>The closing line, which the tooling reads as authoritative.</summary>
    public void Summary()
    {
        int total, passedNow, failedNow, skippedNow;
        lock (this.gate)
        {
            passedNow = this.passed;
            failedNow = this.failed;
            skippedNow = this.skipped;
            total = passedNow + failedNow + skippedNow;
        }
        Write(string.Create(CultureInfo.InvariantCulture,
            $"Summary: Total={total}, Passed={passedNow}, Failed={failedNow}, Blocked=0, Not Run=0, Skipped={skippedNow}"));
    }

    private void Write(string line)
    {
        lock (this.gate)
        {
            writer.WriteLine(line);
            writer.Flush();
        }
    }
}
