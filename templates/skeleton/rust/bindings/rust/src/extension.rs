//! The {{name}} extension of the suite runtime: its actions, and the
//! environment a guarded suite reaches. The Suite Authoring extension passes
//! `--api-url`, `--lab-id` and `--connection-file` to every run of a guarded
//! suite (bddSuite.lab.*); the generated tests read them as
//! BDD_SUITE_OPTION_API_URL and so on. `start` hands them to every action as
//! `request.state` (a `Target`).

use std::collections::BTreeMap;
use std::sync::Arc;

use suiterun::{Action, Extension, ExtensionOption, RunState};

/// The environment a run reaches; empty values when none was given.
#[derive(Debug, Clone, Default)]
pub struct Target {
    pub api_url: String,
    pub lab_id: String,
    pub connection_file: String,
}

/// The {{name}} extension.
pub struct {{Namespace}}Extension;

impl Extension for {{Namespace}}Extension {
    fn name(&self) -> &str {
        "{{name}}"
    }

    fn actions(&self) -> Vec<Action> {
        crate::actions::actions()
    }

    fn options(&self) -> Vec<ExtensionOption> {
        vec![
            ExtensionOption::new("--api-url", "The environment's API URL."),
            ExtensionOption::new("--lab-id", "The environment's id."),
            ExtensionOption::new("--connection-file", "The environment's connection file."),
        ]
    }

    fn start(&self, options: &BTreeMap<String, String>) -> RunState {
        let option = |flag: &str| options.get(flag).cloned().unwrap_or_default();
        let target = Target { api_url: option("--api-url"), lab_id: option("--lab-id"), connection_file: option("--connection-file") };
        RunState { state: Some(Arc::new(target)), ..RunState::default() }
    }
}
