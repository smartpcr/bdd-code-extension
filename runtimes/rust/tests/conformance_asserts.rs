//! The assertion table, row by row.

mod common;

use serde_json::Value;
use suiterun::{assertions, model, value as values};

#[test]
fn every_row_of_the_assertion_table() {
    let cases = model::load(
        &std::fs::read_to_string(common::corpus().join("asserts").join("cases.yaml")).unwrap(),
    )
    .unwrap()
    .value;
    let rows = cases["cases"].as_array().expect("the table holds rows");
    assert!(rows.len() > 80, "only {} rows", rows.len());

    let mut failures: Vec<String> = Vec::new();
    let mut used: Vec<String> = Vec::new();
    for row in rows {
        let operator = row["op"].as_str().unwrap_or_default().to_string();
        used.push(operator.clone());
        let actual = row.get("actual").cloned().unwrap_or(Value::Null);
        let expected = row.get("expected").cloned().unwrap_or(Value::Null);
        let present = row.get("present").and_then(Value::as_bool).unwrap_or(true);
        let label = format!(
            "{operator} of [{}] against [{}]",
            values::to_text(&actual),
            values::to_text(&expected)
        );
        let outcome = assertions::compare(&operator, &actual, &expected, present);
        match row["result"].as_str().unwrap_or_default() {
            "error" => match outcome {
                Ok(value) => failures.push(format!("{label} returned {value}; the table says it cannot be compared at all")),
                Err(failure) => {
                    if let Some(code) = row.get("code").and_then(Value::as_str) {
                        if failure.code.as_deref() != Some(code) {
                            failures.push(format!("{label} is refused with [{failure}]; the table says {code}"));
                        }
                    }
                }
            },
            "pass" => match outcome {
                Ok(true) => {}
                Ok(false) => failures.push(format!("{label} is false; the table says it passes")),
                Err(failure) => failures.push(format!("{label} was refused with [{failure}]; the table says it passes")),
            },
            "fail" => match outcome {
                Ok(false) => {}
                Ok(true) => failures.push(format!("{label} is true; the table says it fails")),
                Err(failure) => failures.push(format!("{label} was refused with [{failure}]; the table says it fails")),
            },
            other => failures.push(format!("{label} states result [{other}], which is not pass, fail or error")),
        }
    }

    let missing: Vec<&str> = assertions::operators()
        .into_iter()
        .filter(|name| *name != "script" && !used.iter().any(|used| used == name))
        .collect();
    assert!(missing.is_empty(), "the table has no row for: {}", missing.join(", "));
    assert!(
        failures.is_empty(),
        "{} of {} rows differ:\n{}",
        failures.len(),
        rows.len(),
        failures.join("\n")
    );
}
