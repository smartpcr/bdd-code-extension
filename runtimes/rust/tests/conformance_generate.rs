//! E3 for Rust (docs/test-providers/design.md): every generate entry of the
//! manifest that is not pending for Rust, through the program: the plan
//! `suiterun generate --plan` prints compared with the expected plan as JSON
//! (key order ignored), or the refusal's exit code and findings.

mod common;

use serde_json::Value;

/// A JSON value with every object's keys sorted, so two plans compare as data.
fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            Value::Object(keys.into_iter().map(|key| (key.clone(), sorted(&map[key]))).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

fn pending_for_rust(entry: &Value) -> bool {
    entry
        .get("pendingIn")
        .and_then(Value::as_array)
        .is_some_and(|runtimes| runtimes.iter().any(|runtime| runtime.as_str() == Some("rust")))
}

#[test]
fn e3_every_generate_entry_of_the_manifest() {
    let corpus = common::corpus();
    let manifest = common::manifest();
    let mut checked = 0;
    let mut failures = Vec::new();
    for entry in manifest["generate"].as_array().expect("the manifest lists generate entries") {
        if pending_for_rust(entry) {
            continue;
        }
        let config = corpus.join(entry["config"].as_str().unwrap());
        let (code, out, err) = common::run_cli(&[
            "generate".to_string(),
            "--config".to_string(),
            config.to_string_lossy().to_string(),
            "--plan".to_string(),
        ]);
        checked += 1;
        let wanted_code = entry["exitCode"].as_i64().unwrap_or(0) as i32;
        if code != wanted_code {
            failures.push(format!("{} exits {code}, not {wanted_code}:\n{out}{err}", config.display()));
            continue;
        }
        if let Some(expected) = entry.get("expected").and_then(Value::as_str) {
            let want: Value = serde_json::from_str(&std::fs::read_to_string(corpus.join(expected)).unwrap()).unwrap();
            let got: Value = match serde_json::from_str(&out) {
                Ok(got) => got,
                Err(failure) => {
                    failures.push(format!("{}: the plan is not JSON ({failure}):\n{out}", config.display()));
                    continue;
                }
            };
            if sorted(&want) != sorted(&got) {
                failures.push(format!("{}: the plan differs:\n{out}", config.display()));
            }
        } else {
            // Each finding is a `file:line:column  CODE  message` line.
            let found: Vec<String> = err
                .lines()
                .map(|line| line.trim_start_matches("suiterun: "))
                .filter_map(|line| {
                    let mut parts = line.split("  ");
                    let place = parts.next()?;
                    let code = parts.next()?;
                    (place.matches(':').count() >= 2 && code.starts_with(['E', 'W'])).then(|| format!("{place} {code}"))
                })
                .collect();
            let wanted: Vec<String> = entry["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .map(|one| format!("{}:{}:{} {}", one["file"].as_str().unwrap(), one["line"], one["column"], one["code"].as_str().unwrap()))
                .collect();
            if found != wanted {
                failures.push(format!("{}: findings {found:?}, not {wanted:?}", config.display()));
            }
        }
    }
    assert_eq!(checked, 2, "generate entries checked");
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
