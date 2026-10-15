//! What an action is, and the core actions every runtime implements.
//!
//! The `core.*` actions are pure: no network, no remote session. They exist so
//! that execution semantics can be tested with nothing deployed, and every
//! runtime implements all five, which is what makes the execute corpus runnable
//! by all of them. A workspace's own actions come from extensions
//! ([`crate::extension::Extension::actions`]), composed into a
//! [`crate::extension::Registry`].

use serde_json::{json, Value};

use crate::extension::{Action, State};

use crate::suite::text_of;
use crate::value as values;

/// What an action failed at, so a trace can name a category rather than read a
/// message back out of a string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionError {
    pub message: String,
    pub reason: crate::trace::Reason,
}

impl ActionError {
    pub fn action(message: impl Into<String>) -> Self {
        ActionError {
            message: message.into(),
            reason: crate::trace::Reason::Action,
        }
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        ActionError {
            message: message.into(),
            reason: crate::trace::Reason::Timeout,
        }
    }

    pub fn assertion(message: impl Into<String>) -> Self {
        ActionError {
            message: message.into(),
            reason: crate::trace::Reason::Assertion,
        }
    }
}

impl std::fmt::Display for ActionError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(&self.message)
    }
}

pub type Outcome = Result<Value, ActionError>;

/// What an action is given: the step after substitution, and the run's context.
#[derive(Clone, Default)]
pub struct Request {
    /// The action's name, as the step calls it.
    pub action: String,
    /// The step, every `${...}` already expanded.
    pub step: Value,
    /// `<prefix>RECORD_PATH` (`BDD_SUITE_RECORD_PATH` by default): where
    /// core.record appends its marker, when set.
    pub record_path: Option<String>,
    /// For an extension's action: what that extension's `start` returned as
    /// state for this run.
    pub state: Option<State>,
}

/// The core actions and `wait`. `wait` runs another step, so the executor runs
/// it itself; it is registered so that it is listed, and so that no extension
/// can take its name.
pub fn core_actions() -> Vec<Action> {
    vec![
        Action::new("core.noop", core_noop),
        Action::new("core.set", core_set),
        Action::new("core.fail", core_fail),
        Action::new("core.sleep", core_sleep),
        Action::new("core.record", core_record),
        Action::new("wait", |_: &Request| {
            Err(ActionError::action("wait runs inside the executor, never as a handler."))
        }),
    ]
}

/// A step that does nothing and says so. What a `then` step uses when its whole
/// job is to carry a sentence and assert on what is already captured.
fn core_noop(_request: &Request) -> Outcome {
    Ok(json!({ "ok": true }))
}

/// Publishes a literal, so a fixture can capture a value without an action that
/// goes somewhere to get one.
fn core_set(request: &Request) -> Outcome {
    match request.step.get("value") {
        Some(value) => Ok(value.clone()),
        None => Err(ActionError::action("core.set: value is required")),
    }
}

/// Fails on purpose, with the message the fixture chose, so a test can assert
/// on attribution rather than on whatever a real action happened to say.
fn core_fail(request: &Request) -> Outcome {
    let message = text_of(&request.step, "message");
    Err(ActionError::action(if message.is_empty() {
        "core.fail: failed on purpose".to_string()
    } else {
        message
    }))
}

/// Sleeps, and is interruptible, which is how a limit proves it cancels work
/// rather than waiting it out.
fn core_sleep(request: &Request) -> Outcome {
    let seconds = request
        .step
        .get("seconds")
        .and_then(values::as_number)
        .unwrap_or(1.0);
    std::thread::sleep(std::time::Duration::from_millis((seconds * 1000.0) as u64));
    Ok(json!({ "sleptSec": seconds }))
}

/// Appends one marker to the trace file the run named, and returns it.
fn core_record(request: &Request) -> Outcome {
    let marker = text_of(&request.step, "marker");
    if marker.is_empty() {
        return Err(ActionError::action("core.record: marker is required"));
    }
    if let Some(path) = &request.record_path {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|failure| ActionError::action(format!("core.record: {path} cannot be written: {failure}")))?;
        writeln!(file, "{marker}")
            .map_err(|failure| ActionError::action(format!("core.record: {path} cannot be written: {failure}")))?;
    }
    Ok(json!({ "marker": marker }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(step: Value) -> Request {
        Request {
            step,
            ..Request::default()
        }
    }

    #[test]
    fn every_core_action_is_registered() {
        let names: Vec<String> = core_actions().into_iter().map(|action| action.name).collect();
        // Five core and the one that runs another step.
        assert_eq!(names, vec!["core.noop", "core.set", "core.fail", "core.sleep", "core.record", "wait"]);
        let wait = core_actions().pop().unwrap();
        assert!((wait.handler)(&request(json!({}))).unwrap_err().message.contains("inside the executor"));
    }

    #[test]
    fn noop_says_it_did_nothing_successfully() {
        assert_eq!(core_noop(&request(json!({}))).unwrap(), json!({ "ok": true }));
    }

    #[test]
    fn set_publishes_the_literal_it_was_given() {
        assert_eq!(core_set(&request(json!({ "value": "x" }))).unwrap(), json!("x"));
        assert_eq!(core_set(&request(json!({ "value": [1, 2] }))).unwrap(), json!([1, 2]));
        assert!(core_set(&request(json!({}))).unwrap_err().message.contains("value is required"));
    }

    #[test]
    fn fail_fails_with_the_wording_the_fixture_chose() {
        assert!(core_fail(&request(json!({}))).unwrap_err().message.contains("failed on purpose"));
        assert_eq!(
            core_fail(&request(json!({ "message": "chosen" }))).unwrap_err().message,
            "chosen"
        );
        assert_eq!(
            core_fail(&request(json!({}))).unwrap_err().reason,
            crate::trace::Reason::Action
        );
    }

    #[test]
    fn sleep_reports_what_it_slept() {
        let outcome = core_sleep(&request(json!({ "seconds": 0.01 }))).unwrap();
        assert_eq!(outcome["sleptSec"], 0.01);
    }

    #[test]
    fn record_writes_the_marker_and_returns_it() {
        let path = std::env::temp_dir().join(format!("suiterun-record-{}.txt", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let request = Request {
            step: json!({ "marker": "first" }),
            record_path: Some(path.to_string_lossy().to_string()),
            ..Request::default()
        };
        assert_eq!(core_record(&request).unwrap()["marker"], "first");
        let request = Request {
            step: json!({ "marker": "second" }),
            record_path: Some(path.to_string_lossy().to_string()),
            ..Request::default()
        };
        assert_eq!(core_record(&request).unwrap()["marker"], "second");
        let written = std::fs::read_to_string(&path).unwrap();
        assert_eq!(written.lines().collect::<Vec<&str>>(), vec!["first", "second"]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn record_with_nowhere_to_write_still_returns_its_marker() {
        assert_eq!(
            core_record(&request(json!({ "marker": "loose" }))).unwrap()["marker"],
            "loose"
        );
        assert!(core_record(&request(json!({})))
            .unwrap_err()
            .message
            .contains("marker is required"));
    }

    #[test]
    fn a_failure_carries_the_category_a_trace_names() {
        assert_eq!(ActionError::timeout("x").reason, crate::trace::Reason::Timeout);
        assert_eq!(ActionError::assertion("x").reason, crate::trace::Reason::Assertion);
        assert_eq!(ActionError::action("x").to_string(), "x");
    }
}
