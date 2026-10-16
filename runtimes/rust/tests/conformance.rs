//! One test file that says the corpus is fully run by this runtime.
//!
//! The family tests beside this one each enumerate the manifest for their own
//! kind. What this one adds is the guarantee that nothing in the manifest falls
//! outside them: an entry of a kind no test handles, a file nobody reads, or a
//! suite calling an action this runtime does not register would otherwise be
//! skipped in silence, and a corpus that is quietly skipped looks like coverage
//! and is not.

mod common;

use std::collections::BTreeSet;
use std::path::Path;

use serde_json::Value;
use suiterun::{model, Registry};

#[test]
fn the_corpus_is_found_from_this_crate_with_its_own_schema() {
    let manifest = common::manifest();
    assert_eq!(manifest["version"], 1);
    assert_eq!(manifest["schemaRoot"], "schema");
    assert!(common::corpus_schema().join("suite.schema.json").is_file());
    assert!(common::corpus_schema().join("actions.catalog.yaml").is_file());
}

#[test]
fn every_entry_is_of_a_kind_this_runtime_runs() {
    let manifest = common::manifest();
    let entries = manifest["entries"].as_array().expect("the manifest lists entries");
    let run_here: BTreeSet<&str> = ["validate", "execute"].into_iter().collect();
    let unknown: Vec<String> = entries
        .iter()
        .map(|entry| entry["kind"].as_str().unwrap_or("(none)").to_string())
        .filter(|kind| !run_here.contains(kind.as_str()))
        .collect();
    assert!(
        unknown.is_empty(),
        "the manifest holds entries of kinds no test here runs: {}",
        unknown.join(", ")
    );
    let validate = entries.iter().filter(|entry| entry["kind"] == "validate").count();
    let execute = entries.iter().filter(|entry| entry["kind"] == "execute").count();
    println!("  {validate} validate and {execute} execute entries");
    assert_eq!(validate, 41, "validate entries");
    assert_eq!(execute, 12, "execute entries");
}

/// Every file the manifest names, relative to the corpus.
fn named() -> Vec<String> {
    let manifest = common::manifest();
    let mut named: Vec<String> = Vec::new();
    let mut take = |value: Option<&Value>| {
        if let Some(text) = value.and_then(Value::as_str) {
            if !text.is_empty() {
                named.push(text.to_string());
            }
        }
    };
    for entry in manifest["entries"].as_array().unwrap() {
        for key in ["suite", "expectation", "catalogOverlay"] {
            take(entry.get(key));
        }
    }
    for support in manifest["support"].as_array().unwrap_or(&Vec::new()) {
        take(Some(support));
    }
    for table in manifest["tables"].as_array().unwrap_or(&Vec::new()) {
        for key in ["context", "cases"] {
            take(table.get(key));
        }
    }
    if let Some(reports) = manifest.get("reports") {
        take(reports.get("definition"));
        for entry in reports["entries"].as_array().unwrap_or(&Vec::new()) {
            for key in ["suite", "expected"] {
                take(entry.get(key));
            }
        }
    }
    named
}

#[test]
fn every_file_the_manifest_names_is_there() {
    let corpus = common::corpus();
    let named = named();
    assert!(named.len() > 100, "{} names", named.len());
    let missing: Vec<String> = named
        .into_iter()
        .filter(|relative| !corpus.join(relative).is_file())
        .collect();
    assert!(missing.is_empty(), "the manifest names files that are not there: {}", missing.join(", "));
}

#[test]
fn every_file_under_validate_and_execute_is_an_entry_or_support() {
    let corpus = common::corpus();
    let known: BTreeSet<String> = named().into_iter().collect();
    let mut stray: Vec<String> = Vec::new();
    fn walk(corpus: &Path, relative: &str, known: &BTreeSet<String>, stray: &mut Vec<String>) {
        for entry in std::fs::read_dir(corpus.join(relative)).unwrap().flatten() {
            let child = format!("{relative}/{}", entry.file_name().to_string_lossy());
            if entry.path().is_dir() {
                walk(corpus, &child, known, stray);
            } else if !known.contains(&child) {
                stray.push(child);
            }
        }
    }
    for folder in ["validate", "execute"] {
        walk(&corpus, folder, &known, &mut stray);
    }
    assert!(stray.is_empty(), "files the manifest does not name: {}", stray.join(", "));
}

#[test]
fn every_action_the_execute_corpus_calls_is_one_this_runtime_registers() {
    let corpus = common::corpus();
    let implemented: BTreeSet<String> = common::corpus_registry().names().into_iter().collect();
    let mut called: BTreeSet<String> = BTreeSet::new();
    for entry in common::manifest()["entries"].as_array().unwrap() {
        if entry["kind"] != "execute" {
            continue;
        }
        let text = std::fs::read_to_string(corpus.join(entry["suite"].as_str().unwrap())).unwrap();
        let suite = model::load(&text).unwrap().value;
        collect_actions(&suite, &mut called);
    }
    assert!(!called.is_empty(), "the execute corpus calls no actions at all");
    let missing: Vec<String> = called
        .iter()
        .filter(|name| !implemented.contains(*name))
        .cloned()
        .collect();
    assert!(
        missing.is_empty(),
        "the execute corpus calls actions this runtime does not register: {}",
        missing.join(", ")
    );
}

fn collect_actions(value: &Value, found: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            if let Some(action) = map.get("action").and_then(Value::as_str) {
                found.insert(action.to_string());
            }
            for item in map.values() {
                collect_actions(item, found);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_actions(item, found);
            }
        }
        _ => {}
    }
}

#[test]
fn the_core_catalogs_rust_set_is_exactly_the_registered_names() {
    // Every core action the core catalog lists for rust is registered, and
    // nothing else is, so a core action cannot be implemented without being
    // declared or declared without being implemented. A workspace's own
    // actions come from extensions.
    let catalog = model::load(&std::fs::read_to_string(common::core_catalog()).unwrap())
        .unwrap()
        .value;
    let mut declared: Vec<String> = catalog["actions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|action| {
            action["bindings"]
                .as_array()
                .map(|bindings| bindings.iter().any(|binding| binding == "rust"))
                .unwrap_or(false)
        })
        .map(|action| action["name"].as_str().unwrap().to_string())
        .collect();
    declared.sort();
    let registered = Registry::core().names();
    println!("  {} registered: {}", registered.len(), registered.join(", "));
    assert_eq!(registered, declared);
    assert_eq!(registered.len(), 6);
}
