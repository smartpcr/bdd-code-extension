using Stopwatch = System.Diagnostics.Stopwatch;
using System.Globalization;
using System.Text;
using Bdd.Suite.Actions;
using Bdd.Suite.Diagnostics;
using Bdd.Suite.Model;
using Bdd.Suite.Schema;
using Bdd.Suite.Tracing;
using Bdd.Suite.Validation;

namespace Bdd.Suite.Execution;

/// <summary>What a suite teardown did.</summary>
public sealed class TeardownResult
{
    /// <summary>Whether the teardown ran at all: only after a setup that ran
    /// (spec/session.md, rule 6).</summary>
    public bool Ran { get; init; }

    public bool Failed { get; init; }

    public string Message { get; init; } = string.Empty;

    public double DurationSec { get; init; }

    public static TeardownResult NotRun { get; } = new();
}

/// <summary>A suite file a test process will not open, because it does not lint
/// clean: partial tests would silently drop cases.</summary>
public sealed class SuiteRefusedException(string message, IReadOnlyList<Diagnostic> findings) : Exception(message)
{
    public IReadOnlyList<Diagnostic> Findings { get; } = findings;
}

/// <summary>
/// One suite file run a phase at a time, so a test framework can call the suite
/// setup, one case and the teardown when it chooses (spec/session.md). The
/// whole-file run, <see cref="Executor.RunFile"/>, is these same calls in order,
/// so a native test run and a <c>suiterun run</c> of a file produce the same
/// results and the same trace.
///
/// The phases are DEC-Y07's, unchanged: the suite setup once before the first
/// selected case; for each case beforeEach, its setup, steps and asserts, its
/// cleanup and afterEach; the teardown once after the last. Setup and
/// beforeEach never throw for a step that fails: they record it, and the case
/// reports it (rule 3). Every case starts from a deep copy of the setup's bag
/// (rule 5). One case runs at a time: the case lock is held from beforeEach to
/// afterEach (rule 7).
/// </summary>
public sealed class SuiteSession
{
    /// <summary>What a skipped guarded case says (spec/session.md, rule 9).</summary>
    public const string GuardedMessage = "guarded suite: set BDD_SUITE_ALLOW_GUARDED=1 to run it";

    private readonly OrderedMap _suite;
    private readonly SuiteSchema _schema;
    private readonly RunLibrary _library;
    private readonly Dictionary<string, OrderedMap> _definitions;
    private readonly Dictionary<string, List<OrderedMap>> _hooks;
    private readonly List<OrderedMap> _cases;
    private readonly bool[] _selected;
    private readonly CaseState?[] _states;
    private readonly object _gate = new();
    private readonly SemaphoreSlim _caseLock = new(1, 1);

    private OrderedMap _suiteScope;
    private bool _setupRan;
    private string _setupError = string.Empty;
    private bool _teardownRan;

    private SuiteSession(string path, OrderedMap suite, SuiteSchema schema, RunContext context, bool guarded)
    {
        Path = path;
        Context = context;
        Guarded = guarded;
        _suite = suite;
        _schema = schema;
        // The name a report carries is the one the file declares, not the file
        // name: two suites in one directory may be renamed without every stored
        // report changing, and the declared name is what a person recognises.
        var name = suite.Text("suite");
        Name = name.Length > 0 ? name : System.IO.Path.GetFileNameWithoutExtension(path);
        _library = SuiteExpansion.ReadLibraries(suite, path);
        _definitions = SuiteExpansion.MetaDefinitions(suite, _library);
        _hooks = SuiteExpansion.ExpandedHooks(suite, _definitions);
        _cases = SuiteExpansion.Cases(suite);
        Cases = _cases.Select(held => held.Text("name")).ToList();
        _selected = _cases
            .Select(held => SuiteExpansion.TagsMatch(SuiteExpansion.CaseTags(suite, held), context.Options.Tags))
            .ToArray();
        _states = new CaseState?[_cases.Count];
        // The suite bag: filled once before the first selected case and read by
        // the teardown after the last.
        _suiteScope = new OrderedMap();
        _suiteScope.Set("capture", new OrderedMap());
        _suiteScope.Set("var", new OrderedMap());
    }

    public string Path { get; }

    /// <summary>The suite's declared name, or the file's name without its
    /// extension.</summary>
    public string Name { get; }

    public RunContext Context { get; }

    /// <summary>Whether the test plan marked this suite guarded.</summary>
    public bool Guarded { get; }

    /// <summary>The case names in file order, examples rows in row order, each
    /// <c>&lt;name&gt; [&lt;column&gt;=&lt;value&gt;, ...]</c>.</summary>
    public IReadOnlyList<string> Cases { get; }

    /// <summary>The run context's trace so far.</summary>
    public Trace Trace => Context.Trace;

    /// <summary>
    /// Open a parsed suite. Nothing runs and nothing is linted: this is what the
    /// whole-file run uses, which has always run a file as it finds it.
    /// </summary>
    public static SuiteSession Open(
        string path, OrderedMap suite, SuiteSchema schema, RunContext context, bool guarded = false) =>
        new(path, suite, schema, context, guarded);

    /// <summary>
    /// Read, lint and open a suite file, which is how a test process opens one:
    /// a file that does not lint clean is refused with its findings, and nothing
    /// runs (spec/test-plan.md, Building the plan, step 2).
    /// </summary>
    public static SuiteSession OpenFile(string path, SuiteSchema schema, RunContext context, bool guarded = false)
    {
        var findings = Findings.Sorted(Validator.File(path, path, schema, new ValidationOptions
        {
            Params = context.Options.Params,
            Extensions = context.Extensions.Composite,
        }));
        if (Findings.Fails(findings, strict: false))
        {
            throw new SuiteRefusedException(
                string.Join('\n', findings.Select(finding => finding.Human()).Prepend(
                    string.Create(CultureInfo.InvariantCulture, $"{path} does not lint clean:"))),
                findings);
        }
        var suite = SuiteDocument.Load(File.ReadAllText(path)).Value as OrderedMap
            ?? throw new SuiteRefusedException(path + " does not hold a YAML mapping.", findings);
        return new SuiteSession(path, suite, schema, context, guarded);
    }

    /// <summary>Whether the run context's tag filter selects this case.</summary>
    public bool IsSelected(string caseName) => _selected[IndexOf(caseName)];

    /// <summary>
    /// Run the suite setup, once (rule 2). It runs only when a case is selected,
    /// the run is not a dry run and the suite is not a guarded one the run
    /// context refuses; a failure is recorded, never thrown (rule 3). Calling it
    /// again does nothing; <see cref="BeforeEach(string)"/> calls it too.
    /// </summary>
    public void Setup()
    {
        lock (_gate)
        {
            if (_setupRan || Context.Options.DryRun || !_selected.Any(held => held) || IsRefusedAsGuarded)
            {
                return;
            }
            _setupRan = true;
            if (_hooks["setup"].Count == 0)
            {
                return;
            }
            var context = NewContext(_suiteScope.DeepClone());
            try
            {
                Executor.RunHook(_hooks["setup"], context, _schema,
                    Executor.LimitOf(_suite, "setupTimeoutSec", Executor.DefaultHookSec),
                    "suite setup", Phase.SuiteSetup, string.Empty, Trace);
            }
            catch (ActionException failure)
            {
                _setupError = failure.Message;
            }
            _suiteScope = context.Scope;
        }
    }

    /// <summary>
    /// Start one case: take the case lock, run the setup if it has not run,
    /// build the case's scope from a deep copy of the setup's bag, and run
    /// beforeEach. A failure is recorded for <see cref="RunCase(string)"/> to
    /// report (rule 3). A case the tag filter leaves out, a case after a failed
    /// setup, a dry run and a refused guarded suite run nothing here.
    /// </summary>
    public void BeforeEach(string caseName) => BeforeEach(IndexOf(caseName));

    /// <inheritdoc cref="BeforeEach(string)"/>
    public void BeforeEach(int index)
    {
        var held = _cases[index];
        _caseLock.Wait();
        try
        {
            var state = new CaseState(Cases[index], held);
            _states[index] = state;
            if (!_selected[index])
            {
                state.Skip(CaseKind.SkippedByTag, "tag filter", Reason.Tag);
                return;
            }
            if (IsRefusedAsGuarded)
            {
                state.Skip(CaseKind.SkippedAsGuarded, GuardedMessage, Reason.Guard);
                return;
            }
            Setup();
            if (_setupError.Length > 0)
            {
                state.Kind = CaseKind.SetupFailed;
                state.Status = Status.Error;
                state.Reason = Reason.SuiteSetup;
                state.Message = "Suite setup failed: " + _setupError;
                return;
            }
            if (Context.Options.DryRun)
            {
                state.Skip(CaseKind.DryRun, "Validated only; live execution pending.", Reason.None);
                return;
            }
            Prepare(state, held);
            try
            {
                Executor.RunHook(_hooks["beforeEach"], state.Context!, _schema,
                    Executor.LimitOf(_suite, "beforeEachTimeoutSec", Executor.DefaultHookSec),
                    "beforeEach", Phase.BeforeEach, state.Name, Trace);
            }
            catch (ActionException failure)
            {
                state.Fail(failure.Message, failure.Reason);
                state.BeforeEachFailed = true;
            }
        }
        catch
        {
            // A suite that cannot be expanded (a meta step that does not resolve)
            // is not a step failure: it propagates, as it always has, and the
            // lock is not left held.
            _states[index] = null;
            _caseLock.Release();
            throw;
        }
    }

    /// <summary>
    /// Run the case itself: its setup, steps and case-level asserts, then its
    /// cleanup, which runs even after a failure. A recorded setup or beforeEach
    /// failure is reported here as the case's result, exactly as the whole-file
    /// run does. The result is final only after <see cref="AfterEach(string)"/>.
    /// </summary>
    public CaseResult RunCase(string caseName) => RunCase(IndexOf(caseName));

    /// <inheritdoc cref="RunCase(string)"/>
    public CaseResult RunCase(int index)
    {
        var state = Started(index, nameof(RunCase));
        if (state.Stage != CaseStage.Started)
        {
            throw new InvalidOperationException(string.Create(CultureInfo.InvariantCulture,
                $"RunCase for '{state.Name}' was called twice; call BeforeEach again to run it again."));
        }
        state.Stage = CaseStage.Ran;
        if (state.Kind == CaseKind.Run)
        {
            RunBody(state);
            RunCleanup(state);
        }
        return state.Result(afterEachFailed: false);
    }

    /// <summary>
    /// Finish one case: run afterEach, settle the case's result (an afterEach
    /// failure makes it failed with reason hook), write its <c>case</c> trace
    /// entry, and release the case lock (rule 4). It never throws for a step
    /// failure; <see cref="CaseResult.AfterEachFailed"/> says whether the
    /// framework's per-test cleanup hook should fail.
    /// </summary>
    public CaseResult AfterEach(string caseName) => AfterEach(IndexOf(caseName));

    /// <inheritdoc cref="AfterEach(string)"/>
    public CaseResult AfterEach(int index)
    {
        var state = Started(index, nameof(AfterEach));
        try
        {
            if (state.Kind == CaseKind.Run && state.Stage == CaseStage.Started)
            {
                // The framework ran beforeEach but never the case. Its cleanup is
                // still owed, and the case did not pass.
                state.Fail("The test framework ran this case's beforeEach but not the case itself.", Reason.Hook);
                RunCleanup(state);
            }
            var afterEachFailed = false;
            if (state.Kind == CaseKind.Run)
            {
                try
                {
                    Executor.RunHook(_hooks["afterEach"], state.Context!, _schema,
                        Executor.LimitOf(_suite, "afterEachTimeoutSec", Executor.DefaultHookSec),
                        "afterEach", Phase.AfterEach, state.Name, Trace);
                }
                catch (ActionException failure)
                {
                    state.Status = Status.Failed;
                    state.Reason = Reason.Hook;
                    state.Message = state.Message + " afterEach failed: " + failure.Message;
                    afterEachFailed = true;
                }
            }
            // A dry run validates and runs nothing, so it traces nothing either.
            if (state.Kind != CaseKind.DryRun)
            {
                Trace.Add(Phase.Case, state.Name, string.Empty, string.Empty, state.Status, state.Reason);
            }
            state.Stage = CaseStage.Settled;
            return state.Result(afterEachFailed);
        }
        finally
        {
            _caseLock.Release();
        }
    }

    /// <summary>
    /// Run the suite teardown, once, on the setup's bag, if the setup ran
    /// (rule 6), after any case in progress finishes. Its failure is returned,
    /// never thrown; a framework's class-level cleanup hook fails on it.
    /// </summary>
    public TeardownResult Teardown()
    {
        _caseLock.Wait();
        try
        {
            lock (_gate)
            {
                if (_teardownRan || !_setupRan)
                {
                    return TeardownResult.NotRun;
                }
                _teardownRan = true;
            }
            if (_hooks["teardown"].Count == 0)
            {
                return new TeardownResult { Ran = true };
            }
            var started = Stopwatch.StartNew();
            try
            {
                Executor.RunHook(_hooks["teardown"], NewContext(_suiteScope), _schema,
                    Executor.LimitOf(_suite, "teardownTimeoutSec", Executor.DefaultHookSec),
                    "suite teardown", Phase.SuiteTeardown, string.Empty, Trace);
                return new TeardownResult { Ran = true, DurationSec = started.Elapsed.TotalSeconds };
            }
            catch (ActionException failure)
            {
                return new TeardownResult
                {
                    Ran = true, Failed = true, Message = failure.Message, DurationSec = started.Elapsed.TotalSeconds,
                };
            }
        }
        finally
        {
            _caseLock.Release();
        }
    }

    private bool IsRefusedAsGuarded => Guarded && !Context.AllowGuarded;

    private int IndexOf(string caseName)
    {
        for (var index = 0; index < Cases.Count; index++)
        {
            if (string.Equals(Cases[index], caseName, StringComparison.Ordinal))
            {
                return index;
            }
        }
        throw new ArgumentException(string.Create(CultureInfo.InvariantCulture,
            $"{Name} has no case named '{caseName}'."), nameof(caseName));
    }

    /// <summary>The state of a case BeforeEach started and AfterEach has not
    /// settled; any other order is refused rather than run (rule 1).</summary>
    private CaseState Started(int index, string operation)
    {
        var state = _states[index];
        if (state is null || state.Stage == CaseStage.Settled)
        {
            throw new InvalidOperationException(string.Create(CultureInfo.InvariantCulture,
                $"{operation} for '{Cases[index]}' needs BeforeEach first."));
        }
        return state;
    }

    private CaseContext NewContext(OrderedMap scope) => new()
    {
        Scope = scope, RecordPath = Context.Options.RecordPath, Run = Context.Extensions,
    };

    /// <summary>The case's scope: a deep copy of the setup's bag, then its
    /// parameters, row, defaults, limit, context keys and variables.</summary>
    private void Prepare(CaseState state, OrderedMap held)
    {
        var run = Context.Extensions;
        state.Clock = Stopwatch.StartNew();
        state.Phases = SuiteExpansion.ExpandedCase(held, _definitions);
        var scope = _suiteScope.DeepClone();
        scope.Set("param", SuiteExpansion.ResolveParams(_library, _suite, held, Context.Options.Params, run.Composite.EnvPrefix));
        if (held.TryGet("__row", out var row))
        {
            scope.Set("row", row);
        }
        var defaults = _library.Defaults.Clone();
        if (_suite.Map("defaults") is { } declaredDefaults)
        {
            foreach (var key in declaredDefaults.Keys)
            {
                defaults.Set(key, declaredDefaults.Value(key));
            }
        }
        foreach (var key in defaults.Keys)
        {
            scope.Set(key, defaults.Value(key));
        }
        scope.Set("defaults", defaults);
        scope.Set("timeoutSec", Executor.LimitOf(held, "timeoutSec", Executor.DefaultCaseSec));
        // The extensions' context keys: a value given for this run wins over the
        // suite's defaults, and a key with neither reads as an empty string. They
        // come from the extensions rather than the file, which is what keeps an
        // address or an environment's name out of a suite.
        foreach (var (key, value) in run.Started.Context)
        {
            scope.Set(key, value);
        }
        foreach (var key in run.Composite.ContextKeys)
        {
            if (!scope.Has(key))
            {
                scope.Set(key, string.Empty);
            }
        }
        SuiteExpansion.ResolveVars(_library, _suite, held, scope, run.Composite.Roots);
        state.Context = NewContext(scope);
        // An extension's rule may hold a case to less than it declares.
        state.CaseLimit = run.Composite.CaseLimitSec(_suite, Executor.LimitOf(held, "timeoutSec", Executor.DefaultCaseSec));
    }

    /// <summary>The case's setup, steps and case-level asserts, unless
    /// beforeEach already failed it.</summary>
    private void RunBody(CaseState state)
    {
        if (state.BeforeEachFailed)
        {
            return;
        }
        var phases = state.Phases!;
        try
        {
            Executor.RunHook(phases["setup"], state.Context!, _schema,
                Executor.LimitOf(state.Held, "setupTimeoutSec", Executor.DefaultHookSec),
                "case setup", Phase.CaseSetup, state.Name, Trace);
            // The case's own limit starts here, after the hooks, because a hook
            // never draws on it.
            var deadline = DateTime.UtcNow.AddSeconds(Math.Max(1, state.CaseLimit));
            var collected = new Dictionary<string, List<object?>>(StringComparer.Ordinal);
            foreach (var step in phases["steps"])
            {
                var produced = Executor.RunStep(step, state.Context!, _schema, deadline, Phase.Step, state.Name, Trace, collected);
                if (produced is not null)
                {
                    var written = new StringBuilder();
                    OrderedMap.WriteJson(produced, written);
                    state.Output.Append(written);
                    state.Output.Append('\n');
                }
            }
            foreach (var one in state.Held.List("asserts") ?? [])
            {
                if (one is not null)
                {
                    Executor.CheckAssertion(one, state.Context!);
                }
            }
        }
        catch (ActionException failure)
        {
            state.Fail(failure.Message, failure.Reason);
        }
    }

    /// <summary>The case's cleanup, in its own bounded window even after the case
    /// timed out.</summary>
    private void RunCleanup(CaseState state)
    {
        var cleanup = state.Phases!["cleanup"];
        if (cleanup.Count == 0)
        {
            return;
        }
        try
        {
            Executor.RunHook(cleanup, state.Context!, _schema,
                Executor.LimitOf(state.Held, "cleanupTimeoutSec", Executor.DefaultCleanupSec),
                "cleanup", Phase.CaseCleanup, state.Name, Trace);
        }
        catch (ActionException failure)
        {
            state.Status = Status.Failed;
            state.Reason = Reason.Cleanup;
            state.Message = state.Message + " Cleanup failed: " + failure.Message;
        }
    }

    private enum CaseKind
    {
        Run,
        SkippedByTag,
        SkippedAsGuarded,
        SetupFailed,
        DryRun,
    }

    private enum CaseStage
    {
        Started,
        Ran,
        Settled,
    }

    private sealed class CaseState(string name, OrderedMap held)
    {
        public string Name { get; } = name;
        public OrderedMap Held { get; } = held;
        public CaseKind Kind { get; set; } = CaseKind.Run;
        public CaseStage Stage { get; set; } = CaseStage.Started;
        public string Status { get; set; } = Tracing.Status.Passed;
        public string Reason { get; set; } = Tracing.Reason.None;
        public string Message { get; set; } = string.Empty;
        public bool BeforeEachFailed { get; set; }
        public StringBuilder Output { get; } = new();
        public Stopwatch? Clock { get; set; }
        public Dictionary<string, List<OrderedMap>>? Phases { get; set; }
        public CaseContext? Context { get; set; }
        public long CaseLimit { get; set; }

        public void Skip(CaseKind kind, string message, string reason)
        {
            Kind = kind;
            Status = Tracing.Status.Skipped;
            Message = message;
            Reason = reason;
        }

        public void Fail(string message, string reason)
        {
            Status = Tracing.Status.Failed;
            Message = message;
            Reason = reason;
        }

        public CaseResult Result(bool afterEachFailed) => new()
        {
            Name = Name,
            Status = Status,
            Reason = Reason,
            AfterEachFailed = afterEachFailed,
            Message = Kind == CaseKind.Run ? Message.Trim() : Message,
            Output = Output.ToString(),
            DurationSec = Clock?.Elapsed.TotalSeconds ?? 0,
        };
    }
}
