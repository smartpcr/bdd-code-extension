using Bdd.Suite.Actions;
using Bdd.Suite.Model;
using Bdd.Suite.Tracing;

namespace Bdd.Suite.Execution;

/// <summary>
/// Told when each step starts and finishes, and of each note an action makes
/// while it runs (spec/events.md). An <see cref="IRunObserver"/> that also
/// implements this is found by a type test, so an observer written before it
/// existed keeps compiling and is told nothing new.
///
/// Every step the run reaches is started and then finished, in that order, a
/// step its guard skips included. A step the run never reaches, because an
/// earlier one failed, is neither.
/// </summary>
public interface IStepObserver
{
    void StepStarted(StepRef step, DateTimeOffset at);

    void StepFinished(StepResult result);

    void Note(StepRef step, string text, DateTimeOffset at);
}

/// <summary>What one step did.</summary>
public sealed class StepResult
{
    public required StepRef Step { get; init; }

    /// <summary>The trace's status (<see cref="Tracing.Status"/>).</summary>
    public required string Status { get; init; }

    /// <summary>The trace's reason; empty when the step passed.</summary>
    public string Reason { get; init; } = Tracing.Reason.None;

    public DateTimeOffset Started { get; init; }
    public DateTimeOffset Finished { get; init; }

    /// <summary>The failure as a report prints it; empty when the step
    /// passed.</summary>
    public string Message { get; init; } = string.Empty;

    /// <summary>The failing action's structured evidence
    /// (<see cref="ActionException.Detail"/>).</summary>
    public object? Detail { get; init; }

    /// <summary>Whether the action returned, so <see cref="Value"/> means
    /// something even when it is null.</summary>
    public bool Returned { get; init; }

    public object? Value { get; init; }

    /// <summary>Each comparison the step's asserts made, in order, up to and
    /// including the first that did not hold.</summary>
    public IReadOnlyList<AssertResult> Asserts { get; init; } = [];
}

/// <summary>One comparison of one assertion. <see cref="Present"/> is false when
/// the var named nothing in the capture bag.</summary>
public sealed record AssertResult(
    string Var, string Operator, object? Expected, object? Actual, bool Present, bool Holds);

/// <summary>Where a step is written, read from each file at most once per
/// run.</summary>
public sealed class StepPositions
{
    private readonly Dictionary<string, SuiteDocument?> _files = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _gate = new();

    /// <summary>The one-based line and column of a pointer in a file; zero when
    /// the file cannot be read or does not have it. A reference without a line is
    /// still a reference: its id is what a reader joins on.</summary>
    public (int Line, int Column) At(string file, string pointer)
    {
        SuiteDocument? document;
        lock (_gate)
        {
            if (!_files.TryGetValue(file, out document))
            {
                try
                {
                    document = SuiteDocument.Load(System.IO.File.ReadAllText(file));
                }
                catch (Exception failure) when (failure is IOException or UnauthorizedAccessException or LoadException)
                {
                    document = null;
                }
                _files[file] = document;
            }
        }
        if (document is null || !document.TryAt(pointer, out var found))
        {
            return (0, 0);
        }
        return (found.Value.Line, found.Value.Column);
    }
}
