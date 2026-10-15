//! The expression table, row by row.
//!
//! `conformance/expressions/cases.yaml` is the specification. Every row states
//! a value and its type, or the code it is refused with, and this runtime is
//! held to all of them. The table reads the corpus extension's context keys,
//! so the scope's roots are the core's and that extension's.

mod common;

use serde_json::Value;
use suiterun::{expr, model, value as values};

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::String(_) => "string",
        Value::Number(number) => {
            if number.as_i64().is_some() {
                "int"
            } else {
                "float"
            }
        }
        Value::Array(_) => "list",
        Value::Object(_) => "object",
    }
}

fn same(produced: &Value, expected: &Value) -> bool {
    match (produced, expected) {
        (Value::Null, Value::Null) => true,
        (Value::Number(one), Value::Number(other)) => {
            one.as_f64().unwrap_or(f64::NAN) == other.as_f64().unwrap_or(f64::NAN)
        }
        _ => values::to_text(produced) == values::to_text(expected),
    }
}

#[test]
fn every_row_of_the_expression_table() {
    let corpus = common::corpus().join("expressions");
    let registry = common::corpus_registry();
    let context = model::load(&std::fs::read_to_string(corpus.join("context.yaml")).unwrap())
        .unwrap()
        .value;
    let cases = model::load(&std::fs::read_to_string(corpus.join("cases.yaml")).unwrap())
        .unwrap()
        .value;
    let rows = cases["cases"].as_array().expect("the table holds rows");
    assert!(rows.len() > 100, "only {} rows", rows.len());

    let mut failures: Vec<String> = Vec::new();
    let mut used: Vec<String> = Vec::new();
    for row in rows {
        let template = row.get("template").and_then(Value::as_str);
        let expression = row.get("expr").and_then(Value::as_str);
        let text = template.or(expression).unwrap_or_default();
        let label = if template.is_some() {
            format!("template [{text}]")
        } else {
            format!("expression [{text}]")
        };
        for reading in expr::read(text, false).functions {
            used.push(reading);
        }
        let stable = row.get("stable").and_then(Value::as_bool).unwrap_or(false);
        let mut scope = expr::Scope::new(&context).with_roots(registry.roots());
        if stable {
            scope = scope.stable();
        }
        let produced = if template.is_some() {
            expr::expand(&Value::String(text.to_string()), &scope)
        } else {
            expr::evaluate(text, &scope)
        };

        if let Some(code) = row.get("code").and_then(Value::as_str) {
            match produced {
                Ok(value) => failures.push(format!("{label} produced {value}; the table says {code}")),
                Err(failure) if failure.code != code => {
                    failures.push(format!("{label} is refused with {}; the table says {code}. It said: {}", failure.code, failure.message))
                }
                Err(_) => {}
            }
            continue;
        }
        let value = match produced {
            Ok(value) => value,
            Err(failure) => {
                failures.push(format!("{label} is refused with {}; the table says it produces a value. It said: {}", failure.code, failure.message));
                continue;
            }
        };
        if let Some(expected) = row.get("type").and_then(Value::as_str) {
            if kind(&value) != expected {
                failures.push(format!("{label} has type {}; the table says {expected}", kind(&value)));
                continue;
            }
        }
        if let Some(expected) = row.get("value") {
            if !same(&value, expected) {
                failures.push(format!("{label} is [{}]; the table says [{}]", values::to_text(&value), values::to_text(expected)));
            }
        }
        if let Some(expected) = row.get("count").and_then(Value::as_i64) {
            let count = value.as_array().map(|items| items.len() as i64).unwrap_or(-1);
            if count != expected {
                failures.push(format!("{label} holds {count} entries; the table says {expected}"));
            }
        }
        if let Some(expected) = row.get("length").and_then(Value::as_i64) {
            let length = values::to_text(&value).chars().count() as i64;
            if length != expected {
                failures.push(format!("{label} is {length} characters; the table says {expected}"));
            }
        }
    }

    let missing: Vec<String> = expr::function_names()
        .into_iter()
        .filter(|name| !used.contains(name))
        .collect();
    assert!(missing.is_empty(), "the table calls no: {}", missing.join(", "));
    assert!(
        failures.is_empty(),
        "{} of {} rows differ:\n{}",
        failures.len(),
        rows.len(),
        failures.join("\n")
    );
}
