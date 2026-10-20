//! The validate corpus: every entry, byte for byte.
//!
//! A runtime conforms when it finds the same problems at the same places. The
//! message wording is not compared, because it is deliberately not part of the
//! contract (spec/diagnostics.md).

mod common;

use serde_json::Value;
use suiterun::{diag, model, schema, validate};

/// The validate entries this runtime runs; each pending one is reported, not
/// returned.
fn validate_entries() -> Vec<Value> {
    common::manifest()["entries"]
        .as_array()
        .expect("the manifest lists entries")
        .iter()
        .filter(|entry| entry["kind"].as_str() == Some("validate"))
        .filter(|entry| {
            let pending = common::pending_here(entry);
            if pending {
                common::report_pending("validate", entry);
            }
            !pending
        })
        .cloned()
        .collect()
}

fn params_of(entry: &Value) -> Vec<(String, String)> {
    entry
        .get("params")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .map(|(name, value)| (name.clone(), suiterun::value::to_text(value)))
                .collect()
        })
        .unwrap_or_default()
}

fn expectation_of(entry: &Value) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(common::corpus().join(entry["expectation"].as_str().unwrap())).unwrap(),
    )
    .unwrap()
}

fn expected_rows(expectation: &Value) -> Vec<String> {
    expectation["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            format!(
                "{}@{}:{} [{}]",
                row["code"].as_str().unwrap(),
                row["line"],
                row["column"],
                row["severity"].as_str().unwrap()
            )
        })
        .collect()
}

#[test]
fn every_validate_entry() {
    let root = common::repo();
    let corpus = common::corpus();
    let schema = schema::load(&common::corpus_schema()).unwrap();
    let registry = common::corpus_registry();

    let mut failures: Vec<String> = Vec::new();
    let mut checked = 0usize;
    for entry in validate_entries() {
        let suite = entry["suite"].as_str().unwrap();
        let path = corpus.join(suite);
        let relative = diag::relative_path(&path, &root);
        let options = validate::Options {
            binding: entry["binding"].as_str().unwrap_or("rust").to_string(),
            binding_check: entry["bindingCheck"].as_bool().unwrap_or(false),
            params: params_of(&entry),
            extensions: registry.clone(),
        };
        // An entry may name an overlay: a small catalog merged over the
        // corpus's, so a rule the catalog drives can be proved without
        // changing the catalog every runtime reads.
        let own_schema = entry
            .get("schemaRoot")
            .and_then(Value::as_str)
            .map(|root| schema::load(&corpus.join(root)).unwrap());
        let schema = own_schema.as_ref().unwrap_or(&schema);
        let effective = match entry.get("catalogOverlay").and_then(Value::as_str) {
            Some(relative) => {
                let overlay = model::load(&std::fs::read_to_string(corpus.join(relative)).unwrap())
                    .unwrap()
                    .value;
                suiterun::schema::with_overlay(schema, &overlay).unwrap()
            }
            None => schema.clone(),
        };
        let produced = validate::file(&path, &relative, &effective, &options).unwrap();
        let expectation = expectation_of(&entry);
        let expected = expected_rows(&expectation);
        let actual: Vec<String> = produced
            .iter()
            .map(|finding| {
                format!(
                    "{}@{}:{} [{}]",
                    finding.code,
                    finding.position.line,
                    finding.position.column,
                    finding.severity.as_str()
                )
            })
            .collect();
        checked += 1;
        if actual != expected {
            failures.push(format!(
                "{suite}\n  produced: {}\n  expected: {}",
                actual.join(" "),
                expected.join(" ")
            ));
            continue;
        }
        let exit = if diag::fails(&produced, expectation["strict"].as_bool().unwrap_or(false)) {
            2
        } else {
            0
        };
        if exit != expectation["exitCode"].as_i64().unwrap_or(0) as i32 {
            failures.push(format!(
                "{suite} exits {exit}; the expectation says {}",
                expectation["exitCode"]
            ));
        }
    }

    println!("  {} of {checked} validate entries match", checked - failures.len());
    assert_eq!(checked, 42, "validate entries checked");
    assert!(
        failures.is_empty(),
        "{} of {checked} entries differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn the_same_entries_through_the_program() {
    // `lint --json` output and exit code, as the command line produces them.
    // A catalog overlay is a library input the shared command line does not take.
    let corpus = common::corpus();
    let mut failures: Vec<String> = Vec::new();
    let mut ran = 0usize;
    for entry in validate_entries() {
        if entry.get("catalogOverlay").and_then(Value::as_str).is_some() {
            continue;
        }
        let expectation = expectation_of(&entry);
        let schema_root = match entry.get("schemaRoot").and_then(Value::as_str) {
            Some(root) => corpus.join(root),
            None => common::corpus_schema(),
        };
        let mut arguments: Vec<String> = vec![
            "lint".into(),
            "--schema-root".into(),
            schema_root.to_string_lossy().to_string(),
            "--path".into(),
            corpus.join(entry["suite"].as_str().unwrap()).to_string_lossy().to_string(),
            "--json".into(),
        ];
        if let Some(binding) = entry["binding"].as_str() {
            arguments.extend(["--binding".to_string(), binding.to_string()]);
        }
        if entry["bindingCheck"].as_bool().unwrap_or(false) {
            arguments.push("--binding-check".into());
        }
        if entry["strict"].as_bool().unwrap_or(false) {
            arguments.push("--strict".into());
        }
        for (name, value) in params_of(&entry) {
            arguments.extend(["--param".to_string(), format!("{name}={value}")]);
        }
        let (code, out, err) = common::run_cli(&arguments);
        ran += 1;
        let produced: Vec<String> = serde_json::from_str::<Value>(&out)
            .unwrap_or(Value::Null)
            .as_array()
            .unwrap_or(&Vec::new())
            .iter()
            .map(|row| {
                format!(
                    "{}@{}:{} [{}]",
                    row["code"].as_str().unwrap_or_default(),
                    row["line"],
                    row["column"],
                    row["severity"].as_str().unwrap_or_default()
                )
            })
            .collect();
        let expected = expected_rows(&expectation);
        if produced != expected || code as i64 != expectation["exitCode"].as_i64().unwrap_or(0) {
            failures.push(format!(
                "{}: exit {code}, {}; expected {}{err}",
                entry["suite"].as_str().unwrap(),
                produced.join(" "),
                expected.join(" ")
            ));
        }
    }
    println!("  {} of {ran} entries match through the program (catalog-overlay entries are library-only)", ran - failures.len());
    assert!(ran >= 30, "only {ran} entries ran");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
