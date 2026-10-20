//! What the conformance corpus needs from a runtime's extension
//! (conformance/README.md): the context keys its suites read, with the values
//! of expressions/context.yaml, fixture.append (execute/capture-isolation.yml),
//! and fixture.throw, which panics (execute/worker-throws.yml,
//! spec/progress.md).

use std::collections::BTreeMap;

use serde_json::{json, Value};
use suiterun::actions::{ActionError, Outcome, Request};
use suiterun::{Action, Extension, RunState};

/// The corpus's extension.
pub struct CorpusExtension;

impl Extension for CorpusExtension {
    fn name(&self) -> &str {
        "the corpus"
    }

    fn actions(&self) -> Vec<Action> {
        vec![Action::new("fixture.append", fixture_append), Action::new("fixture.throw", fixture_throw)]
    }

    fn context_keys(&self) -> Vec<String> {
        ["cluster", "target", "labId", "apiUrl"].map(str::to_string).to_vec()
    }

    fn start(&self, _options: &BTreeMap<String, String>) -> RunState {
        let context = [
            ("cluster", json!("HOST-CL01")),
            ("target", json!("HOST-N1")),
            ("labId", json!("lab1")),
            ("apiUrl", json!("http://api/api/v1")),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_string(), value))
        .collect();
        RunState {
            context,
            ..RunState::default()
        }
    }
}

/// fixture.append: the list it was given, with the item appended. The step is
/// already a copy, so the append can only reach this step's own result.
fn fixture_append(request: &Request) -> Outcome {
    let mut list = match request.step.get("list") {
        Some(Value::Array(items)) => items.clone(),
        _ => return Err(ActionError::action("fixture.append: list must be a list")),
    };
    list.push(request.step.get("item").cloned().unwrap_or(Value::Null));
    Ok(Value::Array(list))
}

/// fixture.throw: a panic, Rust's most unusual failure.
fn fixture_throw(request: &Request) -> Outcome {
    let message = request.step.get("message").and_then(Value::as_str).unwrap_or_default().to_string();
    panic!("{message}");
}
