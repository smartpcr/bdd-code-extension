//! The greeter's extension: what a consumer writes to add its own actions to
//! the runtime. Its suiterun and its generated tests both load it.

use serde_json::json;
use suiterun::actions::{Outcome, Request};
use suiterun::{Action, Extension};

/// The greeter's actions.
pub struct GreeterExtension;

impl Extension for GreeterExtension {
    fn name(&self) -> &str {
        "greeter"
    }

    fn actions(&self) -> Vec<Action> {
        vec![Action::new("greet.say", say), Action::new("greet.shout", shout)]
    }
}

fn name_of(request: &Request) -> String {
    request.step.get("name").and_then(|name| name.as_str()).unwrap_or_default().to_string()
}

fn say(request: &Request) -> Outcome {
    Ok(json!({ "text": format!("Hello, {}!", name_of(request)) }))
}

fn shout(request: &Request) -> Outcome {
    Ok(json!({ "text": format!("HELLO, {}!", name_of(request).to_uppercase()) }))
}
