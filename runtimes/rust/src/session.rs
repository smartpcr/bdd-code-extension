//! The suite session (spec/session.md): one suite file run a phase at a time,
//! so a test framework can call the suite setup, one case and the teardown when
//! it chooses. [`crate::exec::run_file`] is these same calls in order, so a
//! native test run and a `suiterun run` of the same file produce the same
//! results and the same trace.
//!
//! The operations return results and never fail for a step: setup and
//! beforeEach record a failure and the case reports it (rule 3); every case
//! starts from its own deep copy of the setup's bag (rule 5, which a
//! `serde_json::Value` clone already is); and one case of a session runs at a
//! time, because [`Session::before_each`] hands back a guard holding the
//! session's case lock that [`Session::after_each`] consumes (rule 7).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use serde_json::{json, Value};

use crate::exec::{
    self, CaseResult, Context, Options, RunExtensions, DEFAULT_CASE_SEC, DEFAULT_CLEANUP_SEC, DEFAULT_HOOK_SEC,
};
use crate::extension::Registry;
use crate::schema::Schema;
use crate::suite::{self, text_of, Library};
use crate::trace::{Phase, Reason, Status, Trace};
use crate::{diag, model, validate};

/// What a skipped guarded case says (rule 9).
pub const GUARDED_MESSAGE: &str = "guarded suite: set BDD_SUITE_ALLOW_GUARDED=1 to run it";

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A case that panicked while holding a lock has already failed its test;
    // the state it guards is still whole, so the next case goes on with it.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The variable-name part of an option's flag: no leading dashes, upper case,
/// `-` as `_`, so `--api-url` is `API_URL`.
pub fn option_variable(flag: &str) -> String {
    flag.trim_start_matches('-').to_uppercase().replace('-', "_")
}

/// What one test process shares (spec/session.md, "run context"): the
/// extensions, started once and their state shared by every session; the run's
/// options; the trace; whether guarded suites may run; and where the trace is
/// written. `suiterun run` makes one per file over the run's started
/// extensions; a test process makes one when it starts, from its environment.
pub struct RunContext<'a> {
    pub options: Options,
    pub extensions: RunExtensions<'a>,
    pub allow_guarded: bool,
    pub trace_file: Option<PathBuf>,
    trace: Mutex<Trace>,
}

impl<'a> RunContext<'a> {
    /// A context over extensions already started, which is what `suiterun run`
    /// has. It allows guarded suites, as `suiterun` always has.
    pub fn for_run(options: Options, extensions: RunExtensions<'a>) -> Self {
        RunContext {
            options,
            extensions,
            allow_guarded: true,
            trace_file: None,
            trace: Mutex::new(Trace::default()),
        }
    }

    /// A context from named values: `<prefix>OPTION_<FLAG>`, `TAGS`, `DRY_RUN`,
    /// `ALLOW_GUARDED`, `TRACE_FILE` and `RECORD_PATH`, where the prefix is the
    /// extensions' environment prefix. The extensions are started here with
    /// the option values found. Suite parameters keep coming from
    /// `<prefix>PARAM_<NAME>` in the environment, which the runtime already
    /// reads.
    pub fn from_lookup(registry: &'a Registry, lookup: impl Fn(&str) -> Option<String>) -> Self {
        let read = |name: &str| {
            lookup(&format!("{}{name}", registry.env_prefix()))
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        let mut values = BTreeMap::new();
        for option in registry.options() {
            if let Some(given) = read(&format!("OPTION_{}", option_variable(&option.flag))) {
                values.insert(option.flag.clone(), given);
            }
        }
        let tags = read("TAGS")
            .map(|raw| raw.split(',').map(|tag| tag.trim().to_string()).filter(|tag| !tag.is_empty()).collect())
            .unwrap_or_default();
        let options = Options {
            tags,
            params: Vec::new(),
            dry_run: read("DRY_RUN").as_deref() == Some("1"),
            record_path: read("RECORD_PATH"),
            ..Options::default()
        };
        RunContext {
            options,
            extensions: RunExtensions::new(registry, &values),
            allow_guarded: read("ALLOW_GUARDED").as_deref() == Some("1"),
            trace_file: read("TRACE_FILE").map(PathBuf::from),
            trace: Mutex::new(Trace::default()),
        }
    }

    /// [`RunContext::from_lookup`] over the process's environment.
    pub fn from_environment(registry: &'a Registry) -> Self {
        Self::from_lookup(registry, |name| std::env::var(name).ok())
    }

    /// The trace so far.
    pub fn trace(&self) -> Trace {
        locked(&self.trace).clone()
    }

    /// The trace, when the run is over.
    pub fn into_trace(self) -> Trace {
        self.trace.into_inner().unwrap_or_else(PoisonError::into_inner)
    }

    /// An empty trace for one operation, which tells the run's observer of each
    /// entry as it is added (spec/progress.md); none in a dry run, which traces
    /// nothing.
    pub(crate) fn operation_trace(&self) -> Trace {
        let observer = if self.options.dry_run { None } else { self.options.observer.clone() };
        Trace::observed(observer.map(|crate::exec::SharedObserver(observer)| {
            std::sync::Arc::new(move |entry: &crate::trace::Entry| observer.entry(entry)) as crate::trace::EntryHook
        }))
    }

    /// Adds what one operation traced. Each operation traces into its own
    /// list and adds it here when it is done, so sessions running in parallel
    /// never interleave inside one operation.
    pub(crate) fn record(&self, done: Trace) {
        locked(&self.trace).entries.extend(done.entries);
    }

    /// Writes the trace to `trace_file`, when one is named. A test process
    /// calls it when its run ends.
    pub fn write_trace(&self) -> Result<(), String> {
        let Some(path) = &self.trace_file else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let text = serde_json::to_string_pretty(&self.trace().to_json()).unwrap_or_default();
        std::fs::write(path, text + "\n").map_err(|failure| format!("{} cannot be written: {failure}", path.display()))
    }
}

/// What a suite teardown did.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TeardownResult {
    /// False when no setup ran, so neither did the teardown (rule 6).
    pub ran: bool,
    pub failed: bool,
    pub message: String,
    pub duration_sec: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Run,
    Tag,
    Guarded,
    SetupFailed,
    DryRun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Started,
    Ran,
    Settled,
}

struct CaseState<'a> {
    name: String,
    kind: Kind,
    status: Status,
    reason: Option<Reason>,
    message: String,
    before_each_failed: bool,
    output: String,
    begun: Option<Instant>,
    phases: BTreeMap<String, Vec<Value>>,
    context: Option<Context<'a>>,
    case_limit: i64,
}

impl CaseState<'_> {
    fn fail(&mut self, message: String, reason: Reason) {
        self.status = Status::Failed;
        self.message = message;
        self.reason = Some(reason);
    }

    fn skip(&mut self, kind: Kind, message: &str, reason: Option<Reason>) {
        self.kind = kind;
        self.status = Status::Skipped;
        self.message = message.to_string();
        self.reason = reason;
    }

    fn result(&self, after_each_failed: bool) -> CaseResult {
        CaseResult {
            name: self.name.clone(),
            status: self.status,
            reason: self.reason,
            message: if self.kind == Kind::Run { self.message.trim().to_string() } else { self.message.clone() },
            output: self.output.clone(),
            duration_sec: self.begun.map(|begun| begun.elapsed().as_secs_f64()).unwrap_or(0.0),
            after_each_failed,
        }
    }
}

/// One case between [`Session::before_each`] and [`Session::after_each`]: it
/// holds the session's case lock, so no other case of the session starts until
/// it is settled. Dropped without `after_each` (a panic in between), it still
/// runs afterEach and writes the case's trace entry, because afterEach always
/// follows beforeEach (rule 4).
pub struct CaseGuard<'s, 'a> {
    session: &'s Session<'a>,
    index: usize,
    stage: Stage,
    state: CaseState<'a>,
    _lock: MutexGuard<'s, ()>,
}

impl CaseGuard<'_, '_> {
    /// The case's position in [`Session::cases`].
    pub fn index(&self) -> usize {
        self.index
    }
}

impl Drop for CaseGuard<'_, '_> {
    fn drop(&mut self) {
        if self.stage != Stage::Settled {
            let session = self.session;
            session.settle(self);
        }
    }
}

struct SuiteState {
    scope: Value,
    setup_ran: bool,
    setup_error: Option<String>,
    torn_down: bool,
}

/// One suite file run a phase at a time (spec/session.md).
pub struct Session<'a> {
    /// The suite file.
    pub path: PathBuf,
    /// The name the file declares, else its file name.
    pub name: String,
    /// The case names in file order, examples rows in row order.
    pub cases: Vec<String>,
    /// Whether the test plan marks the suite guarded (rule 9).
    pub guarded: bool,
    context: &'a RunContext<'a>,
    schema: &'a Schema,
    model: Value,
    library: Library,
    definitions: BTreeMap<String, Value>,
    hooks: BTreeMap<String, Vec<Value>>,
    case_models: Vec<Value>,
    selected: Vec<bool>,
    state: Mutex<SuiteState>,
    case_lock: Mutex<()>,
}

impl<'a> Session<'a> {
    /// Opens a parsed suite. Nothing runs and nothing is linted: this is what
    /// [`crate::exec::run_file`] uses, which has always run a file as it finds
    /// it. A test process uses [`Session::open_linted`].
    pub fn open(path: &Path, model: Value, schema: &'a Schema, context: &'a RunContext<'a>, guarded: bool) -> Result<Self, String> {
        let library = suite::read_libraries(&model, path)?;
        let definitions = suite::meta_definitions(&model, &library);
        let hooks = suite::expanded_hooks(&model, &definitions)?;
        // The name a report carries is the one the file declares, not the file
        // name: two suites in one directory may be renamed without every stored
        // report changing, and the declared name is what a person recognises.
        let name = match model.get("suite").and_then(Value::as_str) {
            Some(declared) if !declared.is_empty() => declared.to_string(),
            _ => path.file_stem().map(|found| found.to_string_lossy().to_string()).unwrap_or_default(),
        };
        let case_models = suite::cases(&model);
        let cases = case_models.iter().map(|case| text_of(case, "name")).collect();
        let selected = case_models
            .iter()
            .map(|case| {
                suite::tags_match(&suite::case_tags(&model, case), &context.options.tags)
                    && suite::name_matches(&text_of(case, "name"), &context.options.names)
            })
            .collect();
        Ok(Session {
            path: path.to_path_buf(),
            name,
            cases,
            guarded,
            context,
            schema,
            model,
            library,
            definitions,
            hooks,
            case_models,
            selected,
            // The suite bag: filled once before the first selected case and
            // read by the teardown after the last.
            state: Mutex::new(SuiteState {
                scope: json!({ "capture": {}, "var": {} }),
                setup_ran: false,
                setup_error: None,
                torn_down: false,
            }),
            case_lock: Mutex::new(()),
        })
    }

    /// Reads, lints and opens a suite file, as a test process does: a file that
    /// does not lint clean is refused with its findings (as `file:line:column
    /// CODE message` lines) and nothing runs. `shown` is the path the findings
    /// name.
    pub fn open_linted(path: &Path, shown: &str, schema: &'a Schema, context: &'a RunContext<'a>, guarded: bool) -> Result<Self, String> {
        let settings = validate::Options {
            binding: "rust".to_string(),
            extensions: context.extensions.registry.clone(),
            ..validate::Options::default()
        };
        let findings = diag::sorted(validate::file(path, shown, schema, &settings)?);
        if diag::fails(&findings, false) {
            let lines: Vec<String> = findings.iter().map(|finding| finding.to_human()).collect();
            return Err(format!("{shown} does not lint clean, so none of its cases ran:\n{}", lines.join("\n")));
        }
        let text = std::fs::read_to_string(path).map_err(|failure| format!("{} cannot be read: {failure}", path.display()))?;
        let document = model::load(&text).map_err(|failure| format!("{} is not valid YAML: {}", path.display(), failure.message))?;
        Self::open(path, document.value, schema, context, guarded)
    }

    /// The run context's trace so far.
    pub fn trace(&self) -> Trace {
        self.context.trace()
    }

    /// The position of a case by its exact name.
    pub fn index_of(&self, case_name: &str) -> Option<usize> {
        self.cases.iter().position(|name| name == case_name)
    }

    /// Whether the run context's tag filter selects a case.
    pub fn is_selected(&self, index: usize) -> bool {
        self.selected.get(index).copied().unwrap_or(false)
    }

    fn refused_as_guarded(&self) -> bool {
        self.guarded && !self.context.allow_guarded
    }

    fn new_context(&self, scope: Value) -> Context<'a> {
        Context {
            scope,
            record_path: self.context.options.record_path.clone(),
            run: &self.context.extensions,
        }
    }

    /// Runs the suite setup, once (rule 2): only when a case is selected, the
    /// run is not a dry run and the suite is not a guarded one the run context
    /// refuses. A failure is recorded, never returned (rule 3).
    pub fn setup(&self) {
        let mut state = locked(&self.state);
        if state.setup_ran
            || self.context.options.dry_run
            || !self.selected.iter().any(|one| *one)
            || self.refused_as_guarded()
        {
            return;
        }
        state.setup_ran = true;
        let steps = self.hooks.get("setup").cloned().unwrap_or_default();
        if steps.is_empty() {
            return;
        }
        let mut context = self.new_context(state.scope.clone());
        let mut done = self.context.operation_trace();
        let outcome = exec::run_hook(
            &steps,
            &mut context,
            self.schema,
            exec::limit_of(&self.model, "setupTimeoutSec", DEFAULT_HOOK_SEC),
            "suite setup",
            Phase::SuiteSetup,
            None,
            &mut done,
        );
        self.context.record(done);
        state.scope = context.scope;
        if let Err(failure) = outcome {
            state.setup_error = Some(failure.message);
        }
    }

    /// Starts one case: takes the case lock, runs the setup if it has not run,
    /// builds the case's scope from a copy of the setup's bag, and runs
    /// beforeEach. A failure is recorded for [`Session::run_case`] to report.
    /// The error is only for a case the session does not have, or one whose
    /// steps or variables cannot be expanded.
    pub fn before_each<'s>(&'s self, index: usize) -> Result<CaseGuard<'s, 'a>, String> {
        let lock = locked(&self.case_lock);
        let Some(name) = self.cases.get(index) else {
            return Err(format!("{} has no case number {index}", self.name));
        };
        let mut state = CaseState {
            name: name.clone(),
            kind: Kind::Run,
            status: Status::Passed,
            reason: None,
            message: String::new(),
            before_each_failed: false,
            output: String::new(),
            begun: None,
            phases: BTreeMap::new(),
            context: None,
            case_limit: DEFAULT_CASE_SEC,
        };
        if !self.selected[index] {
            state.skip(Kind::Tag, "tag filter", Some(Reason::Tag));
        } else if self.refused_as_guarded() {
            state.skip(Kind::Guarded, GUARDED_MESSAGE, Some(Reason::Guard));
        } else {
            self.setup();
            let (setup_error, scope) = {
                let suite_state = locked(&self.state);
                (suite_state.setup_error.clone(), suite_state.scope.clone())
            };
            if let Some(failure) = setup_error {
                state.kind = Kind::SetupFailed;
                state.status = Status::Error;
                state.reason = Some(Reason::SuiteSetup);
                state.message = format!("Suite setup failed: {failure}");
            } else if self.context.options.dry_run {
                state.skip(Kind::DryRun, "Validated only; live execution pending.", None);
            } else {
                self.prepare(index, &mut state, scope)?;
                let mut done = self.context.operation_trace();
                let outcome = exec::run_hook(
                    self.hooks.get("beforeEach").map(Vec::as_slice).unwrap_or(&[]),
                    state.context.as_mut().expect("prepared"),
                    self.schema,
                    exec::limit_of(&self.model, "beforeEachTimeoutSec", DEFAULT_HOOK_SEC),
                    "beforeEach",
                    Phase::BeforeEach,
                    Some(&state.name),
                    &mut done,
                );
                self.context.record(done);
                if let Err(failure) = outcome {
                    state.fail(failure.message, failure.reason);
                    state.before_each_failed = true;
                }
            }
        }
        Ok(CaseGuard {
            session: self,
            index,
            stage: Stage::Started,
            state,
            _lock: lock,
        })
    }

    /// Builds the case's scope: the setup's bag (a deep copy), then its
    /// parameters, row, defaults, limit, context keys and variables.
    fn prepare(&self, index: usize, state: &mut CaseState<'a>, mut scope: Value) -> Result<(), String> {
        let case = &self.case_models[index];
        let run = &self.context.extensions;
        state.begun = Some(Instant::now());
        state.phases = suite::expanded_case(case, &self.definitions)?;
        if let Some(map) = scope.as_object_mut() {
            let params = suite::resolve_params(&self.library, &self.model, Some(case), &self.context.options.params, run.registry.env_prefix());
            map.insert("param".to_string(), Value::Object(params));
            if let Some(row) = case.get("__row") {
                map.insert("row".to_string(), row.clone());
            }
            let mut defaults = self.library.defaults.clone();
            if let Some(declared) = self.model.get("defaults").and_then(Value::as_object) {
                for (key, value) in declared {
                    defaults.insert(key.clone(), value.clone());
                }
            }
            for (key, value) in &defaults {
                map.insert(key.clone(), value.clone());
            }
            map.insert("defaults".to_string(), Value::Object(defaults));
            map.insert("timeoutSec".to_string(), json!(exec::limit_of(case, "timeoutSec", DEFAULT_CASE_SEC)));
            // The extensions' context keys: a value given for this run wins
            // over the suite's defaults; a key with neither reads as "".
            for (key, value) in run.started.context() {
                map.insert(key.clone(), value.clone());
            }
            for key in run.registry.context_keys() {
                if !map.contains_key(key) {
                    map.insert(key.clone(), Value::String(String::new()));
                }
            }
        }
        suite::resolve_vars(&self.library, &self.model, Some(case), &mut scope, run.registry.roots())?;
        state.context = Some(self.new_context(scope));
        // An extension's rule may cap the limit a case declares.
        state.case_limit = run.registry.case_limit_sec(&self.model, exec::limit_of(case, "timeoutSec", DEFAULT_CASE_SEC));
        Ok(())
    }

    fn owns(&self, guard: &CaseGuard) -> Result<(), String> {
        if std::ptr::eq(guard.session, self) {
            Ok(())
        } else {
            Err(format!("the case {:?} was started by another session", guard.state.name))
        }
    }

    /// Runs the case itself: its setup, steps and case-level asserts, then its
    /// cleanup, which runs even after a failure. A recorded setup or beforeEach
    /// failure is reported here as the case's result, exactly as a whole-file
    /// run does. The result is final only after [`Session::after_each`].
    pub fn run_case(&self, guard: &mut CaseGuard<'_, 'a>) -> Result<CaseResult, String> {
        self.owns(guard)?;
        if guard.stage != Stage::Started {
            return Err(format!(
                "run_case for {:?} was called twice; call before_each again to run it again",
                guard.state.name
            ));
        }
        guard.stage = Stage::Ran;
        if guard.state.kind == Kind::Run {
            self.run_body(guard.index, &mut guard.state);
            self.run_cleanup(guard.index, &mut guard.state);
        }
        Ok(guard.state.result(false))
    }

    fn run_body(&self, index: usize, state: &mut CaseState<'a>) {
        if state.before_each_failed {
            return;
        }
        let mut done = self.context.operation_trace();
        let mut output = String::new();
        let outcome = exec::run_case_body(
            &self.case_models[index],
            &state.phases,
            state.context.as_mut().expect("prepared"),
            self.schema,
            &state.name,
            state.case_limit,
            &mut done,
            &mut output,
        );
        self.context.record(done);
        state.output.push_str(&output);
        match outcome {
            // The case decided it cannot run here (rule 12): skipped, not
            // failed; its cleanup and afterEach still run, and either failing
            // fails it.
            Err(failure) if failure.is_skip() => {
                state.status = Status::Skipped;
                state.reason = Some(Reason::Skip);
                state.message = failure.message;
            }
            Err(failure) => state.fail(failure.message, failure.reason),
            Ok(()) => {}
        }
    }

    /// The case's cleanup, in its own bounded window even after the case
    /// timed out.
    fn run_cleanup(&self, index: usize, state: &mut CaseState<'a>) {
        let cleanup = state.phases.get("cleanup").cloned().unwrap_or_default();
        if cleanup.is_empty() {
            return;
        }
        let mut done = self.context.operation_trace();
        let outcome = exec::run_hook(
            &cleanup,
            state.context.as_mut().expect("prepared"),
            self.schema,
            exec::limit_of(&self.case_models[index], "cleanupTimeoutSec", DEFAULT_CLEANUP_SEC),
            "cleanup",
            Phase::CaseCleanup,
            Some(&state.name),
            &mut done,
        );
        self.context.record(done);
        if let Err(failure) = outcome {
            state.status = Status::Failed;
            state.reason = Some(Reason::Cleanup);
            state.message = format!("{} Cleanup failed: {}", state.message, failure.message);
        }
    }

    /// Finishes one case: runs afterEach, settles the case's result (an
    /// afterEach failure makes it failed with reason hook), writes its `case`
    /// trace entry, and releases the case lock (rule 4).
    /// [`CaseResult::after_each_failed`] says whether the framework's per-test
    /// cleanup should fail.
    pub fn after_each(&self, mut guard: CaseGuard<'_, 'a>) -> CaseResult {
        if let Err(refused) = self.owns(&guard) {
            // Settled by the session that started it, when the guard drops.
            return CaseResult {
                name: guard.state.name.clone(),
                status: Status::Error,
                reason: Some(Reason::Hook),
                message: refused,
                output: String::new(),
                duration_sec: 0.0,
                after_each_failed: false,
            };
        }
        self.settle(&mut guard)
    }

    fn settle(&self, guard: &mut CaseGuard<'_, 'a>) -> CaseResult {
        let index = guard.index;
        let state = &mut guard.state;
        if state.kind == Kind::Run && guard.stage == Stage::Started {
            // The framework ran beforeEach but never the case. Its cleanup is
            // still owed, and the case did not pass.
            state.fail(
                "The test framework ran this case's beforeEach but not the case itself.".to_string(),
                Reason::Hook,
            );
            self.run_cleanup(index, state);
        }
        let mut after_each_failed = false;
        if state.kind == Kind::Run {
            let mut done = self.context.operation_trace();
            let outcome = exec::run_hook(
                self.hooks.get("afterEach").map(Vec::as_slice).unwrap_or(&[]),
                state.context.as_mut().expect("prepared"),
                self.schema,
                exec::limit_of(&self.model, "afterEachTimeoutSec", DEFAULT_HOOK_SEC),
                "afterEach",
                Phase::AfterEach,
                Some(&state.name),
                &mut done,
            );
            if let Err(failure) = outcome {
                state.status = Status::Failed;
                state.reason = Some(Reason::Hook);
                state.message = format!("{} afterEach failed: {}", state.message, failure.message);
                after_each_failed = true;
            }
            self.context.record(done);
        }
        // A dry run validates and runs nothing, so it traces nothing either.
        if state.kind != Kind::DryRun {
            let mut done = self.context.operation_trace();
            done.add(Phase::Case, Some(&state.name), None, None, state.status, state.reason);
            self.context.record(done);
        }
        guard.stage = Stage::Settled;
        state.result(after_each_failed)
    }

    /// Runs the suite teardown, once, on the setup's bag, if the setup ran
    /// (rule 6), after any case in progress is settled. Its failure is in the
    /// result, never an error.
    pub fn teardown(&self) -> TeardownResult {
        let _lock = locked(&self.case_lock);
        let scope = {
            let mut state = locked(&self.state);
            if state.torn_down || !state.setup_ran {
                return TeardownResult::default();
            }
            state.torn_down = true;
            state.scope.clone()
        };
        let steps = self.hooks.get("teardown").cloned().unwrap_or_default();
        if steps.is_empty() {
            return TeardownResult {
                ran: true,
                ..TeardownResult::default()
            };
        }
        let begun = Instant::now();
        let mut context = self.new_context(scope);
        let mut done = self.context.operation_trace();
        let outcome = exec::run_hook(
            &steps,
            &mut context,
            self.schema,
            exec::limit_of(&self.model, "teardownTimeoutSec", DEFAULT_HOOK_SEC),
            "suite teardown",
            Phase::SuiteTeardown,
            None,
            &mut done,
        );
        self.context.record(done);
        TeardownResult {
            ran: true,
            failed: outcome.is_err(),
            message: outcome.err().map(|failure| failure.message).unwrap_or_default(),
            duration_sec: begun.elapsed().as_secs_f64(),
        }
    }
}
