//! An example extension (E3): what a workspace writes to add to the runtime
//! without editing it. It is compiled outside the crate (by the `echo` example
//! and by the integration tests), so it can use only the crate's public API.
//!
//! It adds one of each part of the extension API:
//!
//! ```text
//! action       example.echo    returns its text, prefixed with the region
//! context key  region          ${region} in any expression
//! option       --region        where the region comes from
//! rule         a ceiling       a suite tagged slow keeps every case within 10 seconds
//! ```

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{json, Value};
use suiterun::actions::{ActionError, Request};
use suiterun::diag::Diagnostic;
use suiterun::{Action, Extension, ExtensionOption, RuleInput, RunState};

/// The longest a case of a suite tagged slow may run, in seconds.
pub const SLOW_CEILING_SEC: i64 = 10;

/// The example extension.
pub struct Echo;

/// What a run of the extension holds: the region its option gave.
struct Region(String);

fn is_slow(suite: &Value) -> bool {
    suite
        .get("tags")
        .and_then(Value::as_array)
        .is_some_and(|tags| tags.iter().any(|tag| tag == "slow"))
}

fn echo(request: &Request) -> Result<Value, ActionError> {
    let text = request
        .step
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| ActionError::action("example.echo needs a text."))?;
    let region = request
        .state
        .as_ref()
        .and_then(|state| state.downcast_ref::<Region>())
        .map(|region| region.0.as_str())
        .unwrap_or_default();
    Ok(json!({ "echoed": format!("{region}:{text}") }))
}

impl Extension for Echo {
    fn name(&self) -> &str {
        "example"
    }

    fn actions(&self) -> Vec<Action> {
        vec![Action::new("example.echo", echo)]
    }

    fn context_keys(&self) -> Vec<String> {
        vec!["region".to_string()]
    }

    fn options(&self) -> Vec<ExtensionOption> {
        vec![ExtensionOption::new(
            "--region",
            "The region ${region} reads, and example.echo prefixes.",
        )]
    }

    fn start(&self, options: &BTreeMap<String, String>) -> RunState {
        let region = options.get("--region").cloned().unwrap_or_default();
        RunState {
            context: BTreeMap::from([("region".to_string(), json!(region))]),
            state: Some(Arc::new(Region(region))),
            ..RunState::default()
        }
    }

    /// At lint: a case of a slow suite that declares more than the ceiling is
    /// E205, at the value, like the core's limits.
    fn lint(&self, input: &RuleInput) -> Vec<Diagnostic> {
        if !is_slow(input.suite) {
            return Vec::new();
        }
        let cases = input.suite.get("tests").and_then(Value::as_array);
        cases
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(|(index, case)| {
                let declared = case.get("timeoutSec").and_then(Value::as_i64)?;
                if declared <= SLOW_CEILING_SEC {
                    return None;
                }
                let name = case.get("name").and_then(Value::as_str).unwrap_or_default();
                Some(Diagnostic::error(
                    "E205",
                    input.file,
                    input.document.at(&format!("/tests/{index}/timeoutSec")).value,
                    format!(
                        "Case {name} declares {declared} seconds; a suite tagged slow keeps each case within {SLOW_CEILING_SEC}."
                    ),
                ))
            })
            .collect()
    }

    /// At run time: whatever a slow suite's case declares, it runs within the ceiling.
    fn case_limit_sec(&self, suite: &Value, declared_sec: i64) -> i64 {
        if is_slow(suite) {
            declared_sec.min(SLOW_CEILING_SEC)
        } else {
            declared_sec
        }
    }
}
