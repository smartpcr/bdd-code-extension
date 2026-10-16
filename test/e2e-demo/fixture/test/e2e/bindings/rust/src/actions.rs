//! The demo workspace's actions: its extension of the Rust runtime.
use serde_json::{json, Value};
use suiterun::actions::{ActionError, Outcome, Request};
use suiterun::Action;

/// Every action the workspace adds to the runtime.
pub fn actions() -> Vec<Action> {
    vec![
        Action::new("demo.greet", demo_greet),
    ]
}

fn demo_greet(request: &Request) -> Outcome {
    let name = request
        .step
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| ActionError::action("demo.greet needs a name."))?;
    Ok(json!({ "greeting": format!("Hello, {name}") }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn greet_is_registered() {
        assert!(super::actions().iter().any(|action| action.name == "demo.greet"));
    }
}
