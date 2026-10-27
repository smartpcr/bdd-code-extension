//! The {{name}} actions, Rust binding: one registration per action
//! schema/actions.catalog.yaml declares, and its handler. Each handler reads
//! its step's parameters (after substitution) from `request.step`, does its
//! work, and returns the capture shape the catalog declares; a failure is
//! `ActionError::action`. The Suite Authoring extension's *Declare action* and
//! *Implement in Rust* add the next registration to `actions()` and its
//! handler at the end of this file.

use serde_json::{json, Value};
use suiterun::actions::{ActionError, Outcome, Request};
use suiterun::Action;

/// Every action this binding implements.
pub fn actions() -> Vec<Action> {
    vec![
        Action::new("{{action}}", {{actionSnake}}),
    ]
}

fn {{actionSnake}}(request: &Request) -> Outcome {
    match request.step.get("text") {
        Some(Value::String(text)) if !text.is_empty() => Ok(json!({ "text": text })),
        _ => Err(ActionError::action(format!("{}: text is required", request.action))),
    }
}
