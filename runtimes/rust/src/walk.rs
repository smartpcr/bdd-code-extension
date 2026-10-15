//! Where the steps are.
//!
//! Two views of the same file, because two passes need different ones. The
//! structural pass wants every step once, flattened, with its pointer. The
//! Gherkin rules are per *list* - a case's steps are one scenario and its
//! cleanup is not part of it - so that pass wants the lists.

use serde_json::Value;

/// One step, with where it is written and when it runs.
#[derive(Debug, Clone)]
pub struct StepEntry {
    pub step: Value,
    pub pointer: String,
    pub phase: String,
    /// Ten per step, so a nested step can sit just before the one that drives
    /// it. The dataflow pass compares these to decide whether a capture exists
    /// yet.
    pub order: i64,
}

/// One list of steps, with what to call it in a message.
#[derive(Debug, Clone)]
pub struct StepList {
    pub steps: Vec<Value>,
    pub pointer: String,
    pub name: String,
    pub case: Option<Value>,
    pub case_index: Option<usize>,
}

const HOOKS: [&str; 4] = ["setup", "beforeEach", "afterEach", "teardown"];
const CASE_PHASES: [&str; 3] = ["setup", "steps", "cleanup"];

fn array_of<'a>(model: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    model.get(key).and_then(Value::as_array)
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Flatten one list into an entry per step, nested steps included.
pub fn step_entries(list: Option<&Vec<Value>>, pointer: &str, phase: &str) -> Vec<StepEntry> {
    let mut entries = Vec::new();
    let list = match list {
        Some(list) => list,
        None => return entries,
    };
    for (index, step) in list.iter().enumerate() {
        if step.is_null() {
            continue;
        }
        let order = (index as i64) * 10;
        let step_pointer = format!("{pointer}/{index}");
        // A `wait` runs a nested step and publishes its capture just before
        // polling it, so the nested one is ordered one ahead of its parent.
        if let Some(nested) = step.get("forStep") {
            if !nested.is_null() {
                entries.push(StepEntry {
                    step: nested.clone(),
                    pointer: format!("{step_pointer}/forStep"),
                    phase: phase.to_string(),
                    order: order - 1,
                });
            }
        }
        entries.push(StepEntry {
            step: step.clone(),
            pointer: step_pointer,
            phase: phase.to_string(),
            order,
        });
    }
    entries
}

/// Every step in the file, once.
pub fn all_steps(model: &Value) -> Vec<StepEntry> {
    let mut entries = Vec::new();
    for hook in HOOKS {
        entries.extend(step_entries(array_of(model, hook), &format!("/{hook}"), hook));
    }
    if let Some(metas) = array_of(model, "metaSteps") {
        for (index, meta) in metas.iter().enumerate() {
            if meta.is_null() {
                continue;
            }
            let name = text(meta, "name");
            entries.extend(step_entries(
                meta.get("steps").and_then(Value::as_array),
                &format!("/metaSteps/{index}/steps"),
                &format!("meta {name}"),
            ));
        }
    }
    if let Some(cases) = array_of(model, "tests") {
        for (index, case) in cases.iter().enumerate() {
            if case.is_null() {
                continue;
            }
            for phase in CASE_PHASES {
                entries.extend(step_entries(
                    case.get(phase).and_then(Value::as_array),
                    &format!("/tests/{index}/{phase}"),
                    phase,
                ));
            }
        }
    }
    entries
}

/// Every list of steps in the file, with a name a message can use.
pub fn step_lists(model: &Value) -> Vec<StepList> {
    let mut lists = Vec::new();
    let mut push = |steps: Option<&Vec<Value>>, pointer: String, name: String, case: Option<Value>, case_index: Option<usize>| {
        if let Some(steps) = steps {
            lists.push(StepList {
                steps: steps.clone(),
                pointer,
                name,
                case,
                case_index,
            });
        }
    };
    for hook in HOOKS {
        push(
            array_of(model, hook),
            format!("/{hook}"),
            format!("the suite {hook}"),
            None,
            None,
        );
    }
    if let Some(metas) = array_of(model, "metaSteps") {
        for (index, meta) in metas.iter().enumerate() {
            if meta.is_null() {
                continue;
            }
            push(
                meta.get("steps").and_then(Value::as_array),
                format!("/metaSteps/{index}/steps"),
                format!("meta step {}", text(meta, "name")),
                None,
                None,
            );
        }
    }
    if let Some(cases) = array_of(model, "tests") {
        for (index, case) in cases.iter().enumerate() {
            if case.is_null() {
                continue;
            }
            for phase in CASE_PHASES {
                push(
                    case.get(phase).and_then(Value::as_array),
                    format!("/tests/{index}/{phase}"),
                    format!("case {} {phase}", text(case, "name")),
                    Some(case.clone()),
                    Some(index),
                );
            }
        }
    }
    lists
}

/// The columns a table declares, which is what its first row holds.
pub fn table_columns(table: Option<&Value>) -> Vec<String> {
    let rows = match table.and_then(Value::as_array) {
        Some(rows) => rows,
        None => return Vec::new(),
    };
    for row in rows {
        if let Some(map) = row.as_object() {
            return map.keys().cloned().collect();
        }
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model;

    fn suite(text: &str) -> Value {
        model::load(text).unwrap().value
    }

    #[test]
    fn every_step_is_found_once_with_its_pointer() {
        let model = suite(
            "setup:\n  - action: core.noop\nmetaSteps:\n  - name: m\n    steps:\n      - action: core.set\ntests:\n  - name: c\n    setup:\n      - action: core.record\n    steps:\n      - action: core.fail\n    cleanup:\n      - action: core.sleep\n",
        );
        let pointers: Vec<String> = all_steps(&model).iter().map(|entry| entry.pointer.clone()).collect();
        assert_eq!(
            pointers,
            vec![
                "/setup/0",
                "/metaSteps/0/steps/0",
                "/tests/0/setup/0",
                "/tests/0/steps/0",
                "/tests/0/cleanup/0",
            ]
        );
    }

    #[test]
    fn a_nested_step_runs_just_before_the_one_that_drives_it() {
        let model = suite("tests:\n  - name: c\n    steps:\n      - action: wait\n        forStep:\n          action: core.noop\n");
        let entries = all_steps(&model);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].pointer, "/tests/0/steps/0/forStep");
        assert_eq!(entries[0].order, -1);
        assert_eq!(entries[1].pointer, "/tests/0/steps/0");
        assert_eq!(entries[1].order, 0);
    }

    #[test]
    fn a_blank_entry_in_a_list_is_not_a_step() {
        let model = suite("tests:\n  - name: c\n    steps:\n      - action: core.noop\n      -\n      - action: core.fail\n");
        let entries = all_steps(&model);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].pointer, "/tests/0/steps/2", "the index keeps its place");
    }

    #[test]
    fn the_lists_are_named_for_what_a_message_needs() {
        let model = suite(
            "setup:\n  - action: core.noop\nmetaSteps:\n  - name: m\n    steps:\n      - action: core.set\ntests:\n  - name: c\n    steps:\n      - action: core.fail\n    cleanup:\n      - action: core.sleep\n",
        );
        let names: Vec<String> = step_lists(&model).iter().map(|list| list.name.clone()).collect();
        assert_eq!(
            names,
            vec!["the suite setup", "meta step m", "case c steps", "case c cleanup"]
        );
        let lists = step_lists(&model);
        assert_eq!(lists[2].case_index, Some(0));
        assert!(lists[0].case.is_none());
    }

    #[test]
    fn a_table_declares_its_columns_in_its_first_row() {
        let model = suite("tests:\n  - name: c\n    steps:\n      - action: core.noop\n        table:\n          - { node: N1, state: Up }\n          - { node: N2, state: Down }\n");
        let table = model.pointer("/tests/0/steps/0/table");
        assert_eq!(table_columns(table), vec!["node".to_string(), "state".to_string()]);
        assert!(table_columns(None).is_empty());
        assert!(table_columns(Some(&Value::Null)).is_empty());
    }

    #[test]
    fn a_file_with_nothing_in_it_has_no_steps() {
        let model = suite("suite: empty\n");
        assert!(all_steps(&model).is_empty());
        assert!(step_lists(&model).is_empty());
    }
}
