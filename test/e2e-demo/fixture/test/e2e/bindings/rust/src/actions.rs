//! The demo binding's actions.
use std::collections::BTreeMap;

pub struct Request;
pub type Outcome = Result<String, ActionError>;
pub type Handler = fn(&Request) -> Outcome;

pub struct ActionError(String);
impl ActionError {
    pub fn action(message: String) -> Self {
        ActionError(message)
    }
}

/// Every action this binding implements, by name.
pub fn registry() -> BTreeMap<&'static str, Handler> {
    let mut map: BTreeMap<&'static str, Handler> = BTreeMap::new();
    map.insert("demo.greet", demo_greet);
    map
}

fn demo_greet(_request: &Request) -> Outcome {
    Ok("Hello".to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn greet_is_registered() {
        assert!(super::registry().contains_key("demo.greet"));
    }
}
