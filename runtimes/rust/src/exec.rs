//! Running a suite: the six phases, the limit chain, captures and assertions.
//!
//! The order is DEC-Y07's: suite setup once, then for each case beforeEach, the
//! case setup, its steps, its cleanup and afterEach, and the suite teardown
//! once at the end. A failed suite setup errors every case and the teardown
//! still runs, because state a half-built setup left still has to be undone.
//!
//! A step is bounded by the smaller of its own limit and what remains of the
//! case (DEC-Y08), and the bound is enforced by running the action on its own
//! thread and giving up on it, rather than by checking a clock between steps.
//! Rust cannot kill a thread, so an overrunning step is left running and the
//! process outlives it by however long the run has left; what the case sees is
//! the same either way, which is a failure naming the limit it broke.

use std::collections::BTreeMap;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::actions::{ActionError, Request};
use crate::assertions;
use crate::expr;
use crate::extension::{Registry, Started};
use crate::schema::Schema;
use crate::suite::{self, text_of};
use crate::trace::{Phase, Reason, Status, Trace};
use crate::value as values;

const DEFAULT_CASE_SEC: i64 = 600;
const DEFAULT_HOOK_SEC: i64 = 300;
const DEFAULT_CLEANUP_SEC: i64 = 120;

/// How a run was asked to be done.
#[derive(Debug, Clone, Default)]
pub struct Options {
    pub tags: Vec<String>,
    pub params: Vec<(String, String)>,
    pub dry_run: bool,
    pub record_path: Option<String>,
}

/// The extensions of one run: composed, and started with the run's option
/// values. One per run, shared by every file, so an extension's state
/// persists across files.
pub struct RunExtensions<'a> {
    pub registry: &'a Registry,
    pub started: Started,
}

impl<'a> RunExtensions<'a> {
    /// Starts every extension of `registry` with the values given for its
    /// options (flag to value).
    pub fn new(registry: &'a Registry, values: &BTreeMap<String, String>) -> Self {
        RunExtensions {
            registry,
            started: registry.start(values),
        }
    }
}

/// What one case did.
#[derive(Debug, Clone)]
pub struct CaseResult {
    pub name: String,
    pub status: Status,
    pub message: String,
    pub output: String,
    pub duration_sec: f64,
}

/// What one suite file did.
#[derive(Debug, Clone)]
pub struct SuiteResult {
    pub name: String,
    pub cases: Vec<CaseResult>,
}

/// What a whole run did.
#[derive(Debug, Clone)]
pub struct RunResult {
    pub suites: Vec<SuiteResult>,
    pub trace: Trace,
    pub any_failures: bool,
}

/// The bag one case reads and writes, and the run it belongs to.
struct Context<'a> {
    scope: Value,
    record_path: Option<String>,
    run: &'a RunExtensions<'a>,
}

impl Context<'_> {
    fn capture(&mut self, name: &str, value: Value) {
        if let Some(map) = self
            .scope
            .get_mut("capture")
            .and_then(Value::as_object_mut)
        {
            map.insert(name.to_string(), value);
        }
    }

    fn captured(&self, name: &str) -> Option<&Value> {
        self.scope.get("capture").and_then(|bag| bag.get(name))
    }

    fn has(&self, name: &str) -> bool {
        if self.captured(name).is_some() { return true; }
        let mut current = self.scope.get("capture");
        for part in name.split('.') {
            if part.is_empty() { return false; }
            current = current.and_then(|value| value.as_object()).and_then(|map| map.get(part));
        }
        current.is_some()
    }
}

/// Walk a dotted subject into the capture bag, and say whether it was there at
/// all. Absent and null are different things to isNull and isNotNull, and the
/// same to nothing else.
fn actual(path: &str, context: &Context) -> (Value, bool) {
    let mut current = match context.scope.get("capture") {
        Some(bag) => bag.clone(),
        None => return (Value::Null, false),
    };
    for segment in path.split('.') {
        if current.is_null() {
            return (Value::Null, false);
        }
        if let Value::Array(items) = &current {
            match segment.parse::<usize>() {
                Ok(index) if index < items.len() => {
                    current = items[index].clone();
                    continue;
                }
                Ok(_) => return (Value::Null, false),
                Err(_) => {}
            }
        }
        match current.get(segment) {
            Some(found) => current = found.clone(),
            None => return (Value::Null, false),
        }
    }
    (current, true)
}

/// Compare one assertion and fail when it does not hold. Every operator in one
/// assertion has to pass, and the first failure ends the case.
fn check_assertion(assertion: &Value, context: &Context) -> Result<(), ActionError> {
    let scope = expr::Scope::new(&context.scope).with_roots(context.run.registry.roots());
    let expanded = expr::expand(assertion, &scope)
        .map_err(|failure| ActionError::action(failure.to_string()))?;
    let map = match expanded.as_object() {
        Some(map) => map.clone(),
        None => return Ok(()),
    };
    let subject = match map.get("var").and_then(Value::as_str) {
        Some(var) => var.to_string(),
        None => "(value)".to_string(),
    };
    let (found, present) = match map.get("var").and_then(Value::as_str) {
        Some(var) => actual(var, context),
        None => (Value::Null, false),
    };
    for (operator, expected) in &map {
        if operator == "var" {
            continue;
        }
        if operator == "script" {
            // PowerShell only, and refused elsewhere by the catalog's binding
            // list. A binding that does not run the host language says so
            // rather than passing an assertion it did not make.
            return Err(ActionError::assertion(
                "a script assertion is implemented by the PowerShell binding only".to_string(),
            ));
        }
        let held = assertions::compare(operator, &found, expected, present)
            .map_err(|failure| ActionError::assertion(failure.to_string()))?;
        if !held {
            return Err(ActionError::assertion(assertions::describe(
                &subject, operator, expected, &found, present,
            )));
        }
    }
    Ok(())
}

/// Run one action with a limit, and give up on it when the limit expires.
#[allow(clippy::too_many_arguments)]
fn bounded(
    action: &str,
    step: &Value,
    record_path: Option<String>,
    run: &RunExtensions,
    limit_sec: i64,
    description: &str,
    interruptible: bool,
) -> Result<Value, ActionError> {
    if limit_sec <= 0 {
        return Err(ActionError::timeout(format!(
            "{description} had no time left to run in: the deadline had already passed."
        )));
    }
    // Every action, the core's and the extensions', is found in the run's
    // registry; an extension's action is handed the state its extension
    // started this run with.
    let handler = match run.registry.handler(action) {
        Some(handler) => handler.clone(),
        None => {
            return Err(ActionError::action(format!(
                "Unknown action: {action}. No extension of this runtime registers it."
            )))
        }
    };
    let request = Request {
        action: action.to_string(),
        step: step.clone(),
        record_path,
        state: run.registry.state_for(action, &run.started),
    };
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(handler(&request));
    });
    match receiver.recv_timeout(Duration::from_secs(limit_sec as u64)) {
        Ok(outcome) => outcome,
        Err(_) => {
            let wording = if interruptible {
                "cancelled".to_string()
            } else {
                "abandoned: it holds a remote session this runner cannot interrupt, so the work on the far side continues".to_string()
            };
            Err(ActionError::timeout(format!(
                "{description} exceeded its {limit_sec}s limit and was {wording}."
            )))
        }
    }
}

/// `wait`: sleep, or poll a nested step until an assertion holds.
///
/// The nested step runs inline rather than on its own thread: the poll is
/// inside the bound its parent already holds, and a step that fails transiently
/// is tried again rather than ending the case.
#[allow(clippy::too_many_arguments)]
fn wait(
    step: &Value,
    context: &mut Context,
    schema: &Schema,
    deadline: Instant,
    phase: Phase,
    case_name: Option<&str>,
    trace: &mut Trace,
) -> Result<Value, ActionError> {
    let nested = step.get("forStep").cloned().unwrap_or(Value::Null);
    let seconds = step.get("seconds").and_then(values::as_number).unwrap_or(0.0);
    if seconds > 0.0 && nested.is_null() {
        std::thread::sleep(Duration::from_millis((seconds * 1000.0) as u64));
        return Ok(json!({ "waitedSec": seconds }));
    }
    if nested.is_null() {
        return Err(ActionError::action(
            "wait needs either seconds, or a forStep to poll.".to_string(),
        ));
    }

    let interval = Duration::from_secs(
        step.get("intervalSec").and_then(Value::as_i64).unwrap_or(10).max(1) as u64,
    );
    let own = step.get("timeoutSec").and_then(Value::as_i64).unwrap_or(300);
    let until = Instant::now() + Duration::from_secs(own.max(1) as u64);
    let until = until.min(deadline);
    let started = Instant::now();
    loop {
        let mut collected: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        let attempt = run_step(&nested, context, schema, until, phase, case_name, trace, &mut collected);
        if attempt.is_ok() {
            match step.get("until") {
                Some(assertion) if !assertion.is_null() => {
                    if check_assertion(assertion, context).is_ok() {
                        return Ok(json!({ "waited": true, "elapsedSec": started.elapsed().as_secs() }));
                    }
                }
                _ => return Ok(json!({ "waited": true, "elapsedSec": started.elapsed().as_secs() })),
            }
        }
        if Instant::now() + interval >= until {
            return Err(ActionError::timeout(format!(
                "wait gave up after {}s: the step it polls never satisfied its until.",
                started.elapsed().as_secs()
            )));
        }
        std::thread::sleep(interval);
    }
}

/// Run one step: guard, substitute, act, capture, assert.
#[allow(clippy::too_many_arguments)]
fn run_step(
    step: &Value,
    context: &mut Context,
    schema: &Schema,
    deadline: Instant,
    phase: Phase,
    case_name: Option<&str>,
    trace: &mut Trace,
    collected: &mut BTreeMap<String, Vec<Value>>,
) -> Result<Value, ActionError> {
    let label = suite::step_label(step);
    let action = text_of(step, "action");
    let guard = text_of(step, "ifCapture");
    if !guard.is_empty() && !context.has(&guard) {
        trace.add(phase, case_name, Some(&label), Some(&action), Status::Skipped, Some(Reason::Guard));
        return Ok(Value::Null);
    }

    // The row is bound for this step only: ${row.<column>} reads the row it came
    // from, and the next step sees whatever its own row is, or none.
    if let Some(row) = step.get("__row") {
        if let Some(map) = context.scope.as_object_mut() {
            map.insert("row".to_string(), row.clone());
        }
    }

    let expanded = {
        let scope = expr::Scope::new(&context.scope).with_roots(context.run.registry.roots());
        match expr::expand(step, &scope) {
            Ok(expanded) => expanded,
            Err(failure) => {
                let error = ActionError::action(format!("{label}: {failure}"));
                trace.add(phase, case_name, Some(&label), Some(&action), Status::Failed, Some(error.reason));
                return Err(error);
            }
        }
    };
    if action.is_empty() {
        let error = ActionError::action(format!("{label}: a step names no action"));
        trace.add(phase, case_name, Some(&label), None, Status::Failed, Some(error.reason));
        return Err(error);
    }

    let remaining = deadline.saturating_duration_since(Instant::now()).as_secs() as i64;
    let own = expanded.get("timeoutSec").and_then(Value::as_i64).unwrap_or(0);
    let limit = suite::step_limit(own, remaining.max(0));
    let interruptible = schema
        .actions
        .get(&action)
        .map(|declared| declared.interruptible)
        .unwrap_or(true);

    // `wait` runs another step, so it is the executor's business rather than an
    // entry in the registry: the nested step runs inline, inside the bound its
    // parent already holds, and publishes its capture where the parent can read
    // it.
    let result = if action == "wait" {
        wait(&expanded, context, schema, deadline, phase, case_name, trace)
    } else {
        bounded(
            &action,
            &expanded,
            context.record_path.clone(),
            context.run,
            limit,
            &label,
            interruptible,
        )
    };
    let result = match result {
        Ok(result) => result,
        Err(failure) => {
            trace.add(phase, case_name, Some(&label), Some(&action), Status::Failed, Some(failure.reason));
            let message = if failure.message.starts_with(&label) {
                failure.message
            } else {
                format!("{label}: {}", failure.message)
            };
            return Err(ActionError {
                message,
                reason: failure.reason,
            });
        }
    };

    // A step's capture is its own result while its own assertions run, and only
    // then collected into the list a table publishes. That is what lets a
    // per-row assertion say `seen.marker` and mean this row's result.
    let capture_as = text_of(&expanded, "captureAs");
    if !capture_as.is_empty() {
        context.capture(&capture_as, result.clone());
    }
    for assertion in step.get("asserts").and_then(Value::as_array).unwrap_or(&Vec::new()) {
        if assertion.is_null() {
            continue;
        }
        if let Err(failure) = check_assertion(assertion, context) {
            trace.add(phase, case_name, Some(&label), Some(&action), Status::Failed, Some(failure.reason));
            return Err(ActionError {
                message: format!("{label}: {}", failure.message),
                reason: failure.reason,
            });
        }
    }
    if !capture_as.is_empty() && step.get("__rowCount").is_some() {
        let list = collected.entry(capture_as.clone()).or_default();
        list.push(result.clone());
        let published = Value::Array(list.clone());
        context.capture(&capture_as, published);
    }

    trace.add(phase, case_name, Some(&label), Some(&action), Status::Passed, None);
    Ok(result)
}

/// Run one hook list inside its own window.
#[allow(clippy::too_many_arguments)]
fn run_hook(
    steps: &[Value],
    context: &mut Context,
    schema: &Schema,
    limit_sec: i64,
    label: &str,
    phase: Phase,
    case_name: Option<&str>,
    trace: &mut Trace,
) -> Result<(), ActionError> {
    if steps.is_empty() {
        return Ok(());
    }
    let deadline = Instant::now() + Duration::from_secs(limit_sec.max(1) as u64);
    let mut collected: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for step in steps {
        if let Err(failure) = run_step(step, context, schema, deadline, phase, case_name, trace, &mut collected) {
            // The category is the hook rather than whatever the action was
            // doing: a case whose setup failed did not fail at one of its own
            // steps, and a trace that said 'action' would send a reader looking
            // for one.
            return Err(ActionError {
                message: format!("{label} {}", failure.message),
                reason: Reason::Hook,
            });
        }
    }
    Ok(())
}

fn limit_of(value: &Value, key: &str, fallback: i64) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(fallback)
}

/// Run one suite file, with the run's extensions.
pub fn run_file(
    path: &std::path::Path,
    model: &Value,
    schema: &Schema,
    options: &Options,
    trace: &mut Trace,
    run: &RunExtensions,
) -> Result<SuiteResult, String> {
    // The name a report carries is the one the file declares, not the file
    // name: two suites in one directory may be renamed without every stored
    // report changing, and the declared name is what a person recognises.
    let name = match model.get("suite").and_then(Value::as_str) {
        Some(declared) if !declared.is_empty() => declared.to_string(),
        _ => path
            .file_stem()
            .map(|found| found.to_string_lossy().to_string())
            .unwrap_or_default(),
    };
    let library = suite::read_libraries(model, path)?;
    let definitions = suite::meta_definitions(model, &library);
    let hooks = suite::expanded_hooks(model, &definitions)?;

    let mut result = SuiteResult {
        name: name.clone(),
        cases: Vec::new(),
    };
    let all_cases = suite::cases(model);
    let selected: Vec<&Value> = all_cases
        .iter()
        .filter(|case| {
            let tags = suite::case_tags(model, case);
            suite::tags_match(&tags, &options.tags)
        })
        .collect();

    // The suite bag: filled once before the first selected case and read by the
    // teardown after the last. Every case starts from a copy of it.
    let mut suite_scope = json!({ "capture": {}, "var": {} });
    let mut suite_setup_error: Option<String> = None;
    if !options.dry_run && !selected.is_empty() {
        let steps = hooks.get("setup").cloned().unwrap_or_default();
        if !steps.is_empty() {
            let mut context = Context {
                scope: suite_scope.clone(),
                record_path: options.record_path.clone(),
                run,
            };
            let outcome = run_hook(
                &steps,
                &mut context,
                schema,
                limit_of(model, "setupTimeoutSec", DEFAULT_HOOK_SEC),
                "suite setup",
                Phase::SuiteSetup,
                None,
                trace,
            );
            suite_scope = context.scope;
            if let Err(failure) = outcome {
                suite_setup_error = Some(failure.message);
            }
        }
    }

    for case in &all_cases {
        let case_name = text_of(case, "name");
        let tags = suite::case_tags(model, case);
        if !suite::tags_match(&tags, &options.tags) {
            trace.add(Phase::Case, Some(&case_name), None, None, Status::Skipped, Some(Reason::Tag));
            result.cases.push(CaseResult {
                name: case_name,
                status: Status::Skipped,
                message: "tag filter".to_string(),
                output: String::new(),
                duration_sec: 0.0,
            });
            continue;
        }
        if let Some(failure) = &suite_setup_error {
            trace.add(Phase::Case, Some(&case_name), None, None, Status::Error, Some(Reason::SuiteSetup));
            result.cases.push(CaseResult {
                name: case_name,
                status: Status::Error,
                message: format!("Suite setup failed: {failure}"),
                output: String::new(),
                duration_sec: 0.0,
            });
            continue;
        }
        if options.dry_run {
            result.cases.push(CaseResult {
                name: case_name,
                status: Status::Skipped,
                message: "Validated only; live execution pending.".to_string(),
                output: String::new(),
                duration_sec: 0.0,
            });
            continue;
        }

        let started = Instant::now();
        let phases = suite::expanded_case(case, &definitions)?;
        let mut scope = suite_scope.clone();
        if let Some(map) = scope.as_object_mut() {
            let params = suite::resolve_params(&library, model, Some(case), &options.params, run.registry.env_prefix());
            map.insert("param".to_string(), Value::Object(params));
            if let Some(row) = case.get("__row") {
                map.insert("row".to_string(), row.clone());
            }
            let mut defaults = library.defaults.clone();
            if let Some(declared) = model.get("defaults").and_then(Value::as_object) {
                for (key, value) in declared {
                    defaults.insert(key.clone(), value.clone());
                }
            }
            for (key, value) in &defaults {
                map.insert(key.clone(), value.clone());
            }
            map.insert("defaults".to_string(), Value::Object(defaults));
            map.insert(
                "timeoutSec".to_string(),
                json!(limit_of(case, "timeoutSec", DEFAULT_CASE_SEC)),
            );
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
        suite::resolve_vars(&library, model, Some(case), &mut scope, run.registry.roots())?;
        let mut context = Context {
            scope,
            record_path: options.record_path.clone(),
            run,
        };

        let mut status = Status::Passed;
        let mut message = String::new();
        let mut reason: Option<Reason> = None;
        let mut output = String::new();

        // An extension's rule may cap the limit a case declares.
        let case_limit = run
            .registry
            .case_limit_sec(model, limit_of(case, "timeoutSec", DEFAULT_CASE_SEC));

        let outcome = (|| -> Result<(), ActionError> {
            run_hook(
                hooks.get("beforeEach").map(Vec::as_slice).unwrap_or(&[]),
                &mut context,
                schema,
                limit_of(model, "beforeEachTimeoutSec", DEFAULT_HOOK_SEC),
                "beforeEach",
                Phase::BeforeEach,
                Some(&case_name),
                trace,
            )?;
            run_hook(
                phases.get("setup").map(Vec::as_slice).unwrap_or(&[]),
                &mut context,
                schema,
                limit_of(case, "setupTimeoutSec", DEFAULT_HOOK_SEC),
                "case setup",
                Phase::CaseSetup,
                Some(&case_name),
                trace,
            )?;
            // The case's own limit starts here, after the hooks, because a hook
            // never draws on it.
            let deadline = Instant::now() + Duration::from_secs(case_limit.max(1) as u64);
            let mut collected: BTreeMap<String, Vec<Value>> = BTreeMap::new();
            for step in phases.get("steps").map(Vec::as_slice).unwrap_or(&[]) {
                let produced = run_step(
                    step,
                    &mut context,
                    schema,
                    deadline,
                    Phase::Step,
                    Some(&case_name),
                    trace,
                    &mut collected,
                )?;
                if !produced.is_null() {
                    output.push_str(&serde_json::to_string(&produced).unwrap_or_default());
                    output.push('\n');
                }
            }
            for assertion in case.get("asserts").and_then(Value::as_array).unwrap_or(&Vec::new()) {
                if !assertion.is_null() {
                    check_assertion(assertion, &context)?;
                }
            }
            Ok(())
        })();

        if let Err(failure) = outcome {
            status = Status::Failed;
            message = failure.message;
            reason = Some(failure.reason);
        }

        // Cleanup gets its own bounded window even after a case timed out, and
        // afterEach runs even when the cleanup threw.
        let cleanup = phases.get("cleanup").cloned().unwrap_or_default();
        if !cleanup.is_empty() {
            if let Err(failure) = run_hook(
                &cleanup,
                &mut context,
                schema,
                limit_of(case, "cleanupTimeoutSec", DEFAULT_CLEANUP_SEC),
                "cleanup",
                Phase::CaseCleanup,
                Some(&case_name),
                trace,
            ) {
                status = Status::Failed;
                reason = Some(Reason::Cleanup);
                message = format!("{message} Cleanup failed: {}", failure.message);
            }
        }
        if let Err(failure) = run_hook(
            hooks.get("afterEach").map(Vec::as_slice).unwrap_or(&[]),
            &mut context,
            schema,
            limit_of(model, "afterEachTimeoutSec", DEFAULT_HOOK_SEC),
            "afterEach",
            Phase::AfterEach,
            Some(&case_name),
            trace,
        ) {
            status = Status::Failed;
            reason = Some(Reason::Hook);
            message = format!("{message} afterEach failed: {}", failure.message);
        }

        trace.add(Phase::Case, Some(&case_name), None, None, status, reason);
        result.cases.push(CaseResult {
            name: case_name,
            status,
            message: message.trim().to_string(),
            output,
            duration_sec: started.elapsed().as_secs_f64(),
        });
    }

    // The teardown runs after the last case whether cases passed and whether
    // the setup did: state a failed setup half-built still has to be undone.
    //
    // A teardown that fails is its own entry rather than a change to the last
    // case's result, because a teardown is not a test and the case it would be
    // charged to did nothing wrong. It does fail the run: a suite whose teardown
    // could not undo what it did has not finished cleanly.
    if !options.dry_run && !selected.is_empty() {
        let steps = hooks.get("teardown").cloned().unwrap_or_default();
        if !steps.is_empty() {
            let mut context = Context {
                scope: suite_scope,
                record_path: options.record_path.clone(),
                run,
            };
            let started = Instant::now();
            if let Err(failure) = run_hook(
                &steps,
                &mut context,
                schema,
                limit_of(model, "teardownTimeoutSec", DEFAULT_HOOK_SEC),
                "suite teardown",
                Phase::SuiteTeardown,
                None,
                trace,
            ) {
                result.cases.push(CaseResult {
                    name: "teardown".to_string(),
                    status: Status::Failed,
                    message: failure.message,
                    output: String::new(),
                    duration_sec: started.elapsed().as_secs_f64(),
                });
            }
        }
    }

    Ok(result)
}

/// Whether a run failed, which is what decides between exit 0 and exit 1.
pub fn failed(result: &RunResult) -> bool {
    result.suites.iter().any(|suite| {
        suite
            .cases
            .iter()
            .any(|case| matches!(case.status, Status::Failed | Status::Error))
    })
}

/// One run's captured output, for a report that carries it.
pub fn output_of(case: &CaseResult) -> String {
    case.output.clone()
}

/// One value as the text a report's stdout block holds.
pub fn to_output(value: &Value) -> String {
    values::to_text(value)
}

/// A blank scope, for a caller that needs one.
pub fn empty_scope() -> Value {
    Value::Object(Map::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn core_run() -> RunExtensions<'static> {
        static CORE: std::sync::OnceLock<Registry> = std::sync::OnceLock::new();
        RunExtensions::new(CORE.get_or_init(Registry::core), &BTreeMap::new())
    }

    fn context<'a>(bag: Value, run: &'a RunExtensions<'a>) -> Context<'a> {
        Context {
            scope: json!({ "capture": bag }),
            record_path: None,
            run,
        }
    }

    #[test]
    fn a_subject_walks_into_the_bag_and_says_whether_it_was_there() {
        let run = core_run();
        let context = context(json!({ "cs": { "State": "Up", "Nodes": ["N1", "N2"] }, "nothing": null }), &run);
        assert_eq!(actual("cs.State", &context), (json!("Up"), true));
        assert_eq!(actual("cs.Nodes.1", &context), (json!("N2"), true));
        assert_eq!(actual("cs.Nodes.9", &context).1, false);
        assert_eq!(actual("cs.Missing", &context).1, false);
        assert_eq!(actual("nothing", &context), (Value::Null, true));
        assert_eq!(actual("nothing.deeper", &context).1, false);
    }

    #[test]
    fn an_assertion_that_holds_returns_quietly() {
        let run = core_run();
        let context = context(json!({ "state": "Up" }), &run);
        assert!(check_assertion(&json!({ "var": "state", "equals": "Up" }), &context).is_ok());
        let failure = check_assertion(&json!({ "var": "state", "equals": "Down" }), &context).unwrap_err();
        assert_eq!(failure.reason, Reason::Assertion);
        assert!(failure.message.contains("state"), "{}", failure.message);
    }

    #[test]
    fn a_script_assertion_says_this_binding_does_not_run_one() {
        let run = core_run();
        let context = context(json!({}), &run);
        let refused = check_assertion(&json!({ "script": "$true" }), &context).unwrap_err();
        assert!(refused.message.contains("PowerShell binding only"), "{}", refused.message);
    }

    #[test]
    fn a_step_with_no_time_left_says_so_rather_than_running() {
        let refused = bounded("core.noop", &json!({}), None, &core_run(), 0, "the step", true).unwrap_err();
        assert_eq!(refused.reason, Reason::Timeout);
        assert!(refused.message.contains("no time left"), "{}", refused.message);
    }

    #[test]
    fn an_action_nobody_implements_is_refused_by_name() {
        let refused = bounded("no.such.action", &json!({}), None, &core_run(), 5, "the step", true).unwrap_err();
        assert_eq!(
            refused.message,
            "Unknown action: no.such.action. No extension of this runtime registers it."
        );
    }

    #[test]
    fn a_step_that_overruns_is_given_up_on_at_its_limit() {
        let started = Instant::now();
        let refused = bounded("core.sleep", &json!({ "seconds": 30 }), None, &core_run(), 1, "the sleeping step", true).unwrap_err();
        assert!(started.elapsed().as_secs() < 10, "it waited the sleep out");
        assert_eq!(refused.reason, Reason::Timeout);
        assert!(refused.message.contains("cancelled"), "{}", refused.message);
        let refused = bounded("core.sleep", &json!({ "seconds": 30 }), None, &core_run(), 1, "the step", false).unwrap_err();
        assert!(refused.message.contains("abandoned"), "{}", refused.message);
    }

    #[test]
    fn an_action_that_returns_a_value_gives_it_back() {
        assert_eq!(
            bounded("core.set", &json!({ "value": "held" }), None, &core_run(), 5, "the step", true).unwrap(),
            json!("held")
        );
    }

    #[test]
    fn the_helpers_a_report_uses() {
        let case = CaseResult {
            name: "c".into(),
            status: Status::Passed,
            message: String::new(),
            output: "x".into(),
            duration_sec: 0.0,
        };
        assert_eq!(output_of(&case), "x");
        assert_eq!(to_output(&json!(3)), "3");
        assert!(empty_scope().is_object());
        assert!(!failed(&RunResult { suites: vec![], trace: Trace::default(), any_failures: false }));
        assert!(failed(&RunResult {
            suites: vec![SuiteResult { name: "s".into(), cases: vec![CaseResult { name: "c".into(), status: Status::Failed, message: String::new(), output: String::new(), duration_sec: 0.0 }] }],
            trace: Trace::default(),
            any_failures: true,
        }));
    }
}
