//! E1 for Rust (docs/test-providers/design.md): every execute entry, driven
//! through the session as a test framework drives it (the class hook's setup,
//! each case, the class hook's teardown), emits the expected trace in file
//! order and, with the cases reversed, the expectation with each case's entries
//! moved as a group; and the case results equal the whole-file run's.

mod common;

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;
use suiterun::exec::{self, Options, RunContext, RunExtensions, Session};
use suiterun::trace::Trace;
use suiterun::{model, schema};

fn line(entry: &Value) -> String {
    let part = |name: &str| entry.get(name).and_then(Value::as_str).unwrap_or("").to_string();
    ["phase", "case", "step", "action", "status", "reason"].map(part).join(" | ")
}

/// An expectation with its per-case groups in reverse order: the suite
/// setup's entries first, the teardown's last.
fn cases_reversed(entries: &[Value]) -> Vec<String> {
    let mut setup: Vec<String> = Vec::new();
    let mut teardown: Vec<String> = Vec::new();
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for entry in entries {
        match entry.get("phase").and_then(Value::as_str) {
            Some("suite-setup") => setup.push(line(entry)),
            Some("suite-teardown") => teardown.push(line(entry)),
            _ => {
                let name = entry.get("case").and_then(Value::as_str).unwrap_or("").to_string();
                match groups.last_mut() {
                    Some((last, lines)) if *last == name => lines.push(line(entry)),
                    _ => groups.push((name, vec![line(entry)])),
                }
            }
        }
    }
    setup.into_iter().chain(groups.into_iter().rev().flat_map(|(_, lines)| lines)).chain(teardown).collect()
}

fn summary(result: &exec::CaseResult) -> String {
    format!("{}|{}|{}", result.name, result.status.as_str(), result.message)
}

#[test]
fn e1_every_execute_entry_through_the_session_in_file_order_and_reversed() {
    let corpus = common::corpus();
    let schema = schema::load(&common::corpus_schema()).unwrap();
    let registry = common::corpus_registry();
    let manifest = common::manifest();
    let mut failures = Vec::new();
    let mut checked = 0;
    let mut pending = 0;
    for entry in manifest["entries"].as_array().unwrap() {
        if entry["kind"].as_str() != Some("execute") {
            continue;
        }
        if common::pending_here(entry) {
            common::report_pending("execute", entry);
            pending += 1;
            continue;
        }
        let name = entry["suite"].as_str().unwrap();
        let path = corpus.join(name);
        let suite_model = model::load(&std::fs::read_to_string(&path).unwrap()).unwrap().value;
        let expectation: Value =
            serde_json::from_str(&std::fs::read_to_string(corpus.join(entry["expectation"].as_str().unwrap())).unwrap()).unwrap();
        let wanted = expectation["trace"].as_array().cloned().unwrap_or_default();
        let options = Options {
            tags: entry
                .get("tags")
                .and_then(Value::as_str)
                .map(|tags| tags.split(',').map(|tag| tag.trim().to_string()).filter(|tag| !tag.is_empty()).collect())
                .unwrap_or_default(),
            names: entry
                .get("names")
                .and_then(Value::as_str)
                .map(|names| names.split(',').map(|name| name.trim().to_string()).filter(|name| !name.is_empty()).collect())
                .unwrap_or_default(),
            params: entry
                .get("params")
                .and_then(Value::as_object)
                .map(|params| params.iter().map(|(key, value)| (key.clone(), suiterun::value::to_text(value))).collect())
                .unwrap_or_default(),
            ..Options::default()
        };

        let own_schema = entry
            .get("schemaRoot")
            .and_then(Value::as_str)
            .map(|root| schema::load(&corpus.join(root)).unwrap());
        let schema = own_schema.as_ref().unwrap_or(&schema);
        let drive = |reversed: bool| -> (Vec<String>, Vec<String>) {
            let context = RunContext::for_run(options.clone(), RunExtensions::new(&registry, &BTreeMap::new()));
            let session = Session::open(&path, suite_model.clone(), &schema, &context, false).unwrap();
            session.setup();
            let mut order: Vec<usize> = (0..session.cases.len()).collect();
            if reversed {
                order.reverse();
            }
            let mut results = Vec::new();
            for index in order {
                let mut guard = session.before_each(index).unwrap();
                session.run_case(&mut guard).unwrap();
                results.push(summary(&session.after_each(guard)));
            }
            session.teardown();
            drop(session);
            let lines = context.into_trace().to_json().as_array().unwrap().iter().map(line).collect();
            (lines, results)
        };

        let (in_order, results) = drive(false);
        let expected: Vec<String> = wanted.iter().map(line).collect();
        if in_order != expected {
            failures.push(format!("{name} (file order):\n  {}\nexpected:\n  {}", in_order.join("\n  "), expected.join("\n  ")));
        }
        let (reversed, _) = drive(true);
        let expected = cases_reversed(&wanted);
        if reversed != expected {
            failures.push(format!("{name} (reversed):\n  {}\nexpected:\n  {}", reversed.join("\n  "), expected.join("\n  ")));
        }

        let extensions = RunExtensions::new(&registry, &BTreeMap::new());
        let whole = exec::run_file(Path::new(&path), &suite_model, &schema, &options, &mut Trace::default(), &extensions).unwrap();
        let whole: Vec<String> = whole.cases.iter().filter(|case| case.name != "teardown").map(summary).collect();
        if whole != results {
            failures.push(format!("{name}: results differ from the whole-file run:\n  {}\nvs\n  {}", results.join("\n  "), whole.join("\n  ")));
        }
        checked += 1;
    }
    assert_eq!(checked, 20, "execute entries checked");
    assert_eq!(pending, 0, "execute entries pending in rust");
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
