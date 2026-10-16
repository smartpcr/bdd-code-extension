//! The sample workspace's extension, Rust binding: its shop actions, the
//! context key `store` and the option `--store` that sets it.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::json;
use suiterun::{Action, Extension, ExtensionOption, RunState};

/// The workspace's extension.
pub struct Shop;

impl Extension for Shop {
    fn name(&self) -> &str {
        "shop"
    }

    fn actions(&self) -> Vec<Action> {
        crate::actions::actions()
    }

    fn context_keys(&self) -> Vec<String> {
        vec!["store".to_string()]
    }

    fn options(&self) -> Vec<ExtensionOption> {
        vec![ExtensionOption::new("--store", "The store ${store} reads (main by default).")]
    }

    fn start(&self, options: &BTreeMap<String, String>) -> RunState {
        let store = options
            .get("--store")
            .filter(|store| !store.is_empty())
            .cloned()
            .unwrap_or_else(|| "main".to_string());
        RunState {
            context: BTreeMap::from([("store".to_string(), json!(store))]),
            state: Some(Arc::new(store)),
            ..RunState::default()
        }
    }
}
