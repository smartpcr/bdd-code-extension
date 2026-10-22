using Stopwatch = System.Diagnostics.Stopwatch;
using System.Globalization;
using System.Text;
using Bdd.Suite.Actions;
using Bdd.Suite.Assertions;
using Bdd.Suite.Expressions;
using Bdd.Suite.Extensions;
using Bdd.Suite.Model;
using Bdd.Suite.Schema;
using Bdd.Suite.Tracing;
using Bdd.Suite.Values;
using Bdd.Suite.Walking;

namespace Bdd.Suite.Execution;

/// <summary>How a run was asked to be done.</summary>
public sealed class RunOptions
{
    public IReadOnlyList<string> Tags { get; init; } = [];

    /// <summary>Case-name globs; see SuiteExpansion.NameMatches.</summary>
    public IReadOnlyList<string> Names { get; init; } = [];

    /// <summary>Told of each selected case and each trace entry as the run goes
    /// (spec/progress.md). It never changes what the run does or what the trace
    /// holds.</summary>
    public IRunObserver? Observer { get; init; }

    public IReadOnlyList<KeyValuePair<string, string>> Params { get; init; } = [];
    public bool DryRun { get; init; }
    public string RecordPath { get; init; } = string.Empty;
}

/// <summary>
/// Told when a selected case starts and finishes, and of each trace entry as it
/// is recorded, so a long run can say what it is doing while it does it
/// (spec/progress.md). An observer sees the run; it cannot change it, and
/// nothing it does reaches the trace.
/// </summary>
public interface IRunObserver
{
    void CaseStarted(string suite, string caseName);

    void CaseFinished(string suite, CaseResult result);

    void Entry(TraceEntry entry);
}

/// <summary>What one case did.</summary>
public sealed class CaseResult
{
    public required string Name { get; init; }
    public required string Status { get; set; }

    /// <summary>The trace's reason when the case did not pass (Tracing.Reason),
    /// empty when it passed.</summary>
    public string Reason { get; set; } = string.Empty;

    /// <summary>Whether the afterEach block failed, which a test framework shows
    /// as a failure of its per-test cleanup hook (spec/session.md, rule 4).</summary>
    public bool AfterEachFailed { get; set; }

    public string Message { get; set; } = string.Empty;
    public string Output { get; set; } = string.Empty;
    public double DurationSec { get; set; }
}

/// <summary>What one suite file did.</summary>
public sealed class SuiteResult
{
    public required string Name { get; init; }
    public List<CaseResult> Cases { get; } = [];
}

/// <summary>The bag one case (or one hook) reads and writes. Not the run
/// context of spec/session.md, which is <see cref="RunContext"/>.</summary>
public sealed class CaseContext
{
    public required OrderedMap Scope { get; set; }
    public string RecordPath { get; init; } = string.Empty;

    /// <summary>The run's extensions: the actions it dispatches to, the roots a
    /// path may start at, and each extension's state. The core alone when not
    /// given.</summary>
    public RunExtensions Run { get; init; } = RunExtensions.CoreOnly;

    public void Capture(string name, object? produced)
    {
        if (Scope.Map("capture") is not { } bag)
        {
            bag = new OrderedMap();
            Scope.Set("capture", bag);
        }
        bag.Set(name, produced);
    }

    public bool Has(string name)
    {
        if (Scope.Map("capture")?.Has(name) ?? false) return true;
        object? current = Scope.Map("capture");
        foreach (var part in name.Split('.'))
        {
            if (part.Length == 0 || current is not OrderedMap map || !map.TryGet(part, out current)) return false;
        }
        return true;
    }
}

/// <summary>
/// Running a suite: the six phases, the limit chain, captures and assertions.
///
/// The order is DEC-Y07's: suite setup once, then for each case beforeEach, the
/// case setup, its steps, its cleanup and afterEach, and the suite teardown once
/// at the end. A failed suite setup errors every case and the teardown still
/// runs, because state a half-built setup left still has to be undone.
///
/// A step is bounded by the smaller of its own limit and what remains of the
/// case (DEC-Y08). The bound is a CancellationTokenSource per step, which is
/// DEC-Y09 in C#: an action that waits on something gives up by itself. An
/// action that ignores it is abandoned on its own thread instead, and the case
/// sees the same thing either way: a failure naming the limit it broke.
/// </summary>
public static class Executor
{
    /// <summary>The fallbacks for a limit nobody declared. A stricter limit is
    /// an extension's rule (ExtensionRules.CaseLimitSec), not the core's.</summary>
    internal const long DefaultCaseSec = 600;
    internal const long DefaultHookSec = 300;
    internal const long DefaultCleanupSec = 120;

    /// <summary>Walk a dotted subject into the capture bag, and say whether it
    /// was there at all. Absent and null are different things to isNull and
    /// isNotNull, and the same to nothing else.</summary>
    internal static (object? Value, bool Present) Actual(string path, CaseContext context)
    {
        if (!context.Scope.TryGet("capture", out var current))
        {
            return (null, false);
        }
        foreach (var segment in path.Split('.'))
        {
            if (current is null)
            {
                return (null, false);
            }
            if (current is List<object?> items
                && int.TryParse(segment, NumberStyles.Integer, CultureInfo.InvariantCulture, out var index))
            {
                if (index < 0 || index >= items.Count)
                {
                    return (null, false);
                }
                current = items[index];
                continue;
            }
            if (!Value.TryField(current, segment, out current))
            {
                return (null, false);
            }
        }
        return (current, true);
    }

    /// <summary>Compare one assertion and fail when it does not hold. Every
    /// operator in one assertion has to pass, and the first failure ends the
    /// case.</summary>
    internal static void CheckAssertion(object? raw, CaseContext context)
    {
        object? expanded;
        try
        {
            expanded = Expression.Expand(raw, Scope.Against(context.Scope, context.Run.Composite.Roots));
        }
        catch (ExpressionException failure)
        {
            throw ActionException.Failed(failure.ToString());
        }
        if (expanded is not OrderedMap one)
        {
            return;
        }
        var subject = "(value)";
        object? found = null;
        var present = false;
        var variable = one.Text("var");
        if (variable.Length > 0)
        {
            subject = variable;
            (found, present) = Actual(variable, context);
        }
        foreach (var operator_ in one.Keys)
        {
            if (string.Equals(operator_, "var", StringComparison.Ordinal))
            {
                continue;
            }
            if (string.Equals(operator_, "script", StringComparison.Ordinal))
            {
                // PowerShell only, and refused elsewhere by the catalog's binding
                // list. A binding that does not run the host language says so
                // rather than passing an assertion it did not make.
                throw ActionException.AssertionFailed(
                    "a script assertion is implemented by the PowerShell binding only");
            }
            var expected = one.Value(operator_);
            bool holds;
            try
            {
                holds = Comparer.Compare(operator_, found, expected, present);
            }
            catch (CompareException failure)
            {
                throw ActionException.AssertionFailed(failure.ToString());
            }
            if (!holds)
            {
                throw ActionException.AssertionFailed(
                    Comparer.Describe(subject, operator_, expected, found, present));
            }
        }
    }


    /// <summary>Run one action with a limit, and give up on it when the limit
    /// expires.</summary>
    internal static object? Bounded(
        string name, OrderedMap step, CaseContext context, long limitSec, string description, bool interruptible)
    {
        if (limitSec <= 0)
        {
            throw ActionException.TimedOut(string.Create(CultureInfo.InvariantCulture,
                $"{description} had no time left to run in: the deadline had already passed."));
        }
        // Dispatch goes through the composite: the core's actions and every
        // extension's. Lint follows the catalog; execution follows what is
        // registered, so an action the catalog declares and no extension
        // registers fails here, by name.
        if (!context.Run.Composite.Actions.TryGetValue(name, out var registered)
            || registered.Handler is not { } handler)
        {
            throw ActionException.Failed(string.Create(CultureInfo.InvariantCulture,
                $"Unknown action: {name}. No extension of this runtime registers it."));
        }

        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(limitSec));
        var request = new ActionRequest
        {
            Step = step,
            Action = name,
            RecordPath = context.RecordPath,
            Cancellation = cancellation.Token,
            State = context.Run.Started.State(registered.Owner),
        };

        object? produced = null;
        Exception? failure = null;
        var done = new ManualResetEventSlim(false);
        // Its own thread rather than the thread pool, so an abandoned action
        // cannot hold a pool thread for the rest of the run.
        var worker = new Thread(() =>
        {
            try
            {
                produced = handler(request);
            }
            // Every exception, not only the ones this runtime raises: one escaping
            // this thread would end the process, losing every result and every
            // cleanup still to come; RunStep reports whatever is rethrown as the
            // step's failure (spec/progress.md, "The action worker").
            catch (Exception thrown)
            {
                failure = thrown;
            }
            finally
            {
                done.Set();
            }
        })
        { IsBackground = true, Name = "suiterun " + name };
        worker.Start();

        if (!done.Wait(TimeSpan.FromSeconds(limitSec + 1)))
        {
            var wording = interruptible
                ? "cancelled"
                : "abandoned: it holds a remote session this runner cannot interrupt, so the work on the far side continues";
            throw ActionException.TimedOut(string.Create(CultureInfo.InvariantCulture,
                $"{description} exceeded its {limitSec}s limit and was {wording}."));
        }
        if (failure is not null)
        {
            throw failure;
        }
        return produced;
    }

    /// <summary>
    /// `wait`: sleep, or poll a nested step until an assertion holds.
    ///
    /// The nested step runs inline rather than on its own thread: the poll is
    /// inside the bound its parent already holds, and a step that fails
    /// transiently is tried again rather than ending the case.
    /// </summary>
    private static object? Wait(
        OrderedMap step, CaseContext context, SuiteSchema schema, DateTime deadline,
        string phase, string caseName, Trace trace)
    {
        var nested = step.Map("forStep");
        var seconds = Value.TryNumber(step.Value("seconds"), out var given) ? given : 0.0;
        if (seconds > 0 && nested is null)
        {
            Thread.Sleep(TimeSpan.FromSeconds(seconds));
            var slept = new OrderedMap();
            slept.Set("waitedSec", seconds);
            return slept;
        }
        if (nested is null)
        {
            throw ActionException.Failed("wait needs either seconds, or a forStep to poll.");
        }

        var intervalSec = step.Value("intervalSec") as long? is { } declared && declared > 0 ? declared : 10;
        var interval = TimeSpan.FromSeconds(intervalSec);
        var ownSec = step.Value("timeoutSec") as long? is { } own && own > 0 ? own : 300;
        var until = DateTime.UtcNow.AddSeconds(ownSec);
        if (until > deadline)
        {
            until = deadline;
        }
        var started = Stopwatch.StartNew();
        while (true)
        {
            var collected = new Dictionary<string, List<object?>>(StringComparer.Ordinal);
            var attempted = true;
            try
            {
                RunStep(nested, context, schema, until, phase, caseName, trace, collected);
            }
            // A skip is the case's decision, not a step that is not ready yet: it
            // ends the case rather than being polled again (session.md rule 12).
            catch (ActionException failure) when (!failure.IsSkip)
            {
                attempted = false;
            }
            if (attempted)
            {
                var assertions = step.Value("until");
                if (assertions is null)
                {
                    return Waited(started);
                }
                try
                {
                    CheckAssertion(assertions, context);
                    return Waited(started);
                }
                catch (ActionException)
                {
                    // Not yet. Poll again while there is time.
                }
            }
            if (DateTime.UtcNow + interval >= until)
            {
                throw ActionException.TimedOut(string.Create(CultureInfo.InvariantCulture,
                    $"wait gave up after {(long)started.Elapsed.TotalSeconds}s: the step it polls never satisfied its until."));
            }
            Thread.Sleep(interval);
        }
    }

    private static OrderedMap Waited(Stopwatch started)
    {
        var out_ = new OrderedMap();
        out_.Set("waited", true);
        out_.Set("elapsedSec", (long)started.Elapsed.TotalSeconds);
        return out_;
    }

    /// <summary>Run one step: guard, substitute, act, capture, assert.</summary>
    internal static object? RunStep(
        OrderedMap step, CaseContext context, SuiteSchema schema, DateTime deadline,
        string phase, string caseName, Trace trace, Dictionary<string, List<object?>> collected)
    {
        var label = SuiteExpansion.StepLabel(step);
        var action = step.Text("action");
        var guard = step.Text("ifCapture");
        if (guard.Length > 0 && !context.Has(guard))
        {
            trace.Add(phase, caseName, label, action, Status.Skipped, Reason.Guard);
            return null;
        }

        // The row is bound for this step only: ${row.<column>} reads the row it
        // came from, and the next step sees whatever its own row is, or none.
        if (step.TryGet("__row", out var row))
        {
            context.Scope.Set("row", row);
        }

        OrderedMap expanded;
        try
        {
            expanded = Expression.Expand(step, Scope.Against(context.Scope, context.Run.Composite.Roots)) as OrderedMap ?? step;
        }
        catch (ExpressionException failure)
        {
            var refused = ActionException.Failed(string.Create(CultureInfo.InvariantCulture,
                $"{label}: {failure}"));
            trace.Add(phase, caseName, label, action, Status.Failed, refused.Reason);
            throw refused;
        }
        if (action.Length == 0)
        {
            var refused = ActionException.Failed(string.Create(CultureInfo.InvariantCulture,
                $"{label}: a step names no action"));
            trace.Add(phase, caseName, label, string.Empty, Status.Failed, refused.Reason);
            throw refused;
        }

        var remaining = (long)Math.Max(0, (deadline - DateTime.UtcNow).TotalSeconds);
        var ownLimit = expanded.Value("timeoutSec") as long? ?? 0;
        var limit = SuiteExpansion.StepLimit(ownLimit, remaining);
        var interruptible = schema.Actions.TryGetValue(action, out var declared) ? declared.Interruptible : true;

        object? produced;
        try
        {
            // `wait` runs another step, so it is the executor's business rather
            // than an entry in the registry: the nested step runs inline, inside
            // the bound its parent already holds, and publishes its capture where
            // the parent can read it.
            produced = string.Equals(action, "wait", StringComparison.Ordinal)
                ? Wait(expanded, context, schema, deadline, phase, caseName, trace)
                : Bounded(action, expanded, context, limit, label, interruptible);
        }
        catch (Exception thrown)
        {
            var reason = thrown is ActionException held ? held.Reason : Reason.Action;
            var skipped = string.Equals(reason, Reason.Skip, StringComparison.Ordinal);
            trace.Add(phase, caseName, label, action, skipped ? Status.Skipped : Status.Failed, reason);
            var message = thrown.Message.StartsWith(label, StringComparison.Ordinal)
                ? thrown.Message
                : label + ": " + thrown.Message;
            throw new ActionException(message, reason);
        }

        // A step's capture is its own result while its own assertions run, and
        // only then collected into the list a table publishes. That is what lets
        // a per-row assertion say `seen.marker` and mean this row's result.
        var captureAs = expanded.Text("captureAs");
        if (captureAs.Length > 0)
        {
            context.Capture(captureAs, produced);
        }
        foreach (var one in step.List("asserts") ?? [])
        {
            if (one is null)
            {
                continue;
            }
            try
            {
                CheckAssertion(one, context);
            }
            catch (ActionException failure)
            {
                trace.Add(phase, caseName, label, action, Status.Failed, failure.Reason);
                throw new ActionException(label + ": " + failure.Message, failure.Reason);
            }
        }
        if (captureAs.Length > 0 && step.Has("__rowCount"))
        {
            if (!collected.TryGetValue(captureAs, out var list))
            {
                list = [];
                collected[captureAs] = list;
            }
            list.Add(produced);
            context.Capture(captureAs, new List<object?>(list));
        }

        trace.Add(phase, caseName, label, action, Status.Passed, Reason.None);
        return produced;
    }

    /// <summary>Run one hook list inside its own window.</summary>
    internal static void RunHook(
        List<OrderedMap> steps, CaseContext context, SuiteSchema schema, long limitSec,
        string label, string phase, string caseName, Trace trace)
    {
        if (steps.Count == 0)
        {
            return;
        }
        var deadline = DateTime.UtcNow.AddSeconds(Math.Max(1, limitSec));
        var collected = new Dictionary<string, List<object?>>(StringComparer.Ordinal);
        foreach (var step in steps)
        {
            try
            {
                RunStep(step, context, schema, deadline, phase, caseName, trace, collected);
            }
            catch (ActionException failure)
            {
                // A case's own setup may skip its case (session.md rule 12); in
                // any other hook a skip is that hook's failure.
                if (failure.IsSkip && string.Equals(phase, Phase.CaseSetup, StringComparison.Ordinal))
                {
                    throw;
                }
                // The category is the hook rather than whatever the action was
                // doing: a case whose setup failed did not fail at one of its own
                // steps, and a trace that said 'action' would send a reader
                // looking for one.
                throw new ActionException(label + " " + failure.Message, Reason.Hook);
            }
        }
    }

    internal static long LimitOf(OrderedMap held, string key, long fallback) =>
        held.Value(key) as long? ?? fallback;

    /// <summary>
    /// Run one suite file: the whole-file run every `suiterun run` does, built on
    /// the session a test framework drives a phase at a time (spec/session.md).
    /// The suite setup runs before the first case, as it always has, so a case a
    /// tag filter skips is traced after it; then each case through beforeEach, the
    /// case and afterEach; then the teardown, whose failure is its own entry.
    /// </summary>
    public static SuiteResult RunFile(
        string path, OrderedMap suite, SuiteSchema schema, RunOptions options, Trace trace,
        RunExtensions? extensions = null)
    {
        var context = RunContext.ForRun(options, extensions ?? RunExtensions.CoreOnly, trace);
        var session = SuiteSession.Open(path, suite, schema, context);
        var result = new SuiteResult { Name = session.Name };
        // A dry run traces nothing, so its observer hears nothing either.
        var observer = options.DryRun ? null : options.Observer;
        if (observer is not null)
        {
            trace.Added += observer.Entry;
        }
        try
        {
            session.Setup();
            for (var index = 0; index < session.Cases.Count; index++)
            {
                // Only the cases this run selected are reported (spec/progress.md).
                var observed = observer is not null && session.IsSelected(session.Cases[index]);
                if (observed)
                {
                    observer!.CaseStarted(session.Name, session.Cases[index]);
                }
                session.BeforeEach(index);
                session.RunCase(index);
                var finished = session.AfterEach(index);
                result.Cases.Add(finished);
                if (observed)
                {
                    observer!.CaseFinished(session.Name, finished);
                }
            }

            // A teardown that fails is its own entry rather than a change to the last
            // case's result, because a teardown is not a test and the case it would
            // be charged to did nothing wrong. It does fail the run: a suite whose
            // teardown could not undo what it did has not finished cleanly.
            var teardown = session.Teardown();
            if (teardown.Failed)
            {
                result.Cases.Add(new CaseResult
                {
                    Name = "teardown",
                    Status = Status.Failed,
                    Reason = Reason.Hook,
                    Message = teardown.Message,
                    DurationSec = teardown.DurationSec,
                });
            }
            return result;
        }
        finally
        {
            if (observer is not null)
            {
                trace.Added -= observer.Entry;
            }
        }
    }

    /// <summary>Whether a run failed, which is what decides between exit 0 and
    /// exit 1.</summary>
    public static bool Failed(IEnumerable<SuiteResult> suites) =>
        suites.Any(suite => suite.Cases.Any(held =>
            string.Equals(held.Status, Status.Failed, StringComparison.Ordinal)
            || string.Equals(held.Status, Status.Error, StringComparison.Ordinal)));

    /// <summary>
    /// Every action name this runtime implements, sorted: the core actions, the
    /// step that runs another step (wait), and every extension's. A portability
    /// check is answered from the whole list.
    /// </summary>
    public static List<string> AllNames(Composite? extensions = null) =>
        (extensions ?? Composite.CoreOnly).Names();
}
