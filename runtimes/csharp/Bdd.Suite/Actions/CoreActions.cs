using System.Globalization;
using Bdd.Suite.Model;
using Bdd.Suite.Tracing;
using Bdd.Suite.Values;

namespace Bdd.Suite.Actions;

/// <summary>What an action failed at, so a trace can name a category rather than
/// read a message back out of a string.</summary>
public sealed class ActionException(string message, string reason) : Exception(message)
{
    public string Reason { get; } = reason;

    /// <summary>A plain action failure.</summary>
    public static ActionException Failed(string message) => new(message, Tracing.Reason.Action);

    /// <summary>A failure because a limit expired.</summary>
    public static ActionException TimedOut(string message) => new(message, Tracing.Reason.Timeout);

    /// <summary>A failure because a comparison did not hold.</summary>
    public static ActionException AssertionFailed(string message) => new(message, Tracing.Reason.Assertion);

    /// <summary>Not a failure: the case cannot run here, so it ends as skipped
    /// with this message, and its cleanup and afterEach still run (spec/session.md
    /// rule 12). Outside a case's setup and steps it is that hook's failure.</summary>
    public static ActionException Skipped(string message) => new(message, Tracing.Reason.Skip);

    /// <summary>Whether this ends the case as skipped rather than failing it.</summary>
    public bool IsSkip => string.Equals(Reason, Tracing.Reason.Skip, StringComparison.Ordinal);

    /// <summary>Structured evidence of the failure, such as the checks a verdict
    /// was made of, written to the event stream as JSON (spec/events.md). It never
    /// changes what the trace or the report say.</summary>
    public object? Detail { get; private set; }

    /// <summary>Attach structured evidence and return this failure, so an action
    /// can write <c>throw ActionException.Failed(text).WithDetail(checks)</c>.</summary>
    public ActionException WithDetail(object? detail)
    {
        Detail = detail;
        return this;
    }
}

/// <summary>
/// What an action is given: the step after substitution, and the run's context.
///
/// The deadline rides on the cancellation token, which is what DEC-Y09 looks
/// like in C#: an action that waits on something reads it and gives up on its
/// own, rather than being abandoned by the caller.
/// </summary>
public sealed class ActionRequest
{
    public required OrderedMap Step { get; init; }
    public string Action { get; init; } = string.Empty;
    public string RecordPath { get; init; } = string.Empty;
    public CancellationToken Cancellation { get; init; }

    /// <summary>For an extension's action: what that extension's Start
    /// returned as its state for this run. Null for a core action.</summary>
    public object? State { get; init; }

    /// <summary>The step being run: which case, which row and where it is written
    /// (spec/events.md). An action that keeps per-case state keys it by
    /// <see cref="StepRef.Case"/>. Null when the request was built outside a
    /// run, as a unit test of an action may.</summary>
    public StepRef? Ref { get; init; }

    /// <summary>Where <see cref="Note"/> sends its text; null when nobody
    /// listens.</summary>
    public Action<string>? OnNote { get; init; }

    /// <summary>Say what a long action is doing while it does it, such as
    /// "waiting for Ready (3 of 30 polls)". It goes to the event stream against
    /// this step and nowhere else: not the trace and not the report.</summary>
    public void Note(string text)
    {
        if (text.Length > 0)
        {
            OnNote?.Invoke(text);
        }
    }
}

/// <summary>
/// The actions this binding implements, and the registry that finds one.
///
/// The core.* actions are pure: no network, no remote session. They exist so
/// that execution semantics can be tested without an environment, and every
/// runtime implements all six, which is what makes the execute corpus runnable
/// by all of them. Any other action comes from an extension (DEC-S03).
/// </summary>
public static class CoreActions
{
    /// <summary>Every core action this binding implements, by name.</summary>
    public static IReadOnlyDictionary<string, Func<ActionRequest, object?>> Registry { get; } =
        new Dictionary<string, Func<ActionRequest, object?>>(StringComparer.Ordinal)
        {
            ["core.noop"] = Noop,
            ["core.set"] = Set,
            ["core.fail"] = Fail,
            ["core.skip"] = Skip,
            ["core.sleep"] = Sleep,
            ["core.record"] = Record,
        };

    /// <summary>Every core action name, sorted.</summary>
    public static List<string> Names()
    {
        var names = Registry.Keys.ToList();
        names.Sort(StringComparer.Ordinal);
        return names;
    }

    /// <summary>Does nothing and says so. What a `then` step uses when its whole
    /// job is to carry a sentence and assert on what is already captured.</summary>
    private static object? Noop(ActionRequest request)
    {
        var out_ = new OrderedMap();
        out_.Set("ok", true);
        return out_;
    }

    /// <summary>Publishes a literal, so a fixture can capture a value without an
    /// action that goes somewhere to get one.</summary>
    private static object? Set(ActionRequest request)
    {
        if (!request.Step.TryGet("value", out var held))
        {
            throw ActionException.Failed("core.set: value is required");
        }
        return held;
    }

    /// <summary>Fails on purpose, with the message the fixture chose, so a test
    /// can assert on attribution rather than on whatever a real action happened
    /// to say.</summary>
    private static object? Fail(ActionRequest request)
    {
        var message = request.Step.Text("message");
        throw ActionException.Failed(message.Length > 0 ? message : "core.fail: failed on purpose");
    }

    /// <summary>Ends its case as skipped, with the message the suite chose: what
    /// a case does when it finds its environment cannot run it (spec/session.md
    /// rule 12), usually guarded by ifCapture.</summary>
    private static object? Skip(ActionRequest request)
    {
        var message = request.Step.Text("message");
        throw ActionException.Skipped(message.Length > 0 ? message : "core.skip: skipped on purpose");
    }

    /// <summary>Sleeps, and is interruptible, which is how a limit proves it
    /// cancels work rather than waiting it out.</summary>
    private static object? Sleep(ActionRequest request)
    {
        var seconds = Value.TryNumber(request.Step.Value("seconds"), out var given) ? given : 1.0;
        if (request.Cancellation.WaitHandle.WaitOne(TimeSpan.FromSeconds(seconds)))
        {
            throw ActionException.TimedOut("core.sleep was cancelled before it finished.");
        }
        var out_ = new OrderedMap();
        out_.Set("sleptSec", seconds);
        return out_;
    }

    // Sessions of one process may run in parallel (spec/session.md, rule 7), and
    // two appends to one file at once can fail on Windows: one at a time.
    private static readonly object RecordGate = new();

    /// <summary>Appends one marker to the trace file the run named, and returns
    /// it.</summary>
    private static object? Record(ActionRequest request)
    {
        var marker = request.Step.Text("marker");
        if (marker.Length == 0)
        {
            throw ActionException.Failed("core.record: marker is required");
        }
        if (request.RecordPath.Length > 0)
        {
            try
            {
                lock (RecordGate)
                {
                    File.AppendAllText(request.RecordPath, marker + "\n");
                }
            }
            catch (Exception failure) when (failure is IOException or UnauthorizedAccessException)
            {
                throw ActionException.Failed(string.Create(CultureInfo.InvariantCulture,
                    $"core.record: {request.RecordPath} cannot be written: {failure.Message}"));
            }
        }
        var out_ = new OrderedMap();
        out_.Set("marker", marker);
        return out_;
    }
}
