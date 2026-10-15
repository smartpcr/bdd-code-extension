//! The assertion operators, and the one comparison rule each of them has.
//!
//! `conformance/asserts/cases.yaml` is the specification. `equals`
//! comparing 3 with "3" as equal and `contains` ignoring case are decisions
//! rather than accidents of the language this is written in, which is why they
//! are data there rather than a paragraph here.

use regex::Regex;
use serde_json::Value;

use crate::value as values;

/// Every operator the comparer implements, which the reference renders and a
/// test compares against the schema.
pub fn operators() -> Vec<&'static str> {
    vec![
        "equals",
        "notEquals",
        "contains",
        "notContains",
        "startsWith",
        "endsWith",
        "matches",
        "in",
        "gt",
        "gte",
        "lt",
        "lte",
        "count",
        "isTrue",
        "isFalse",
        "isNull",
        "isNotNull",
        "script",
    ]
}

/// The regular expression constructs one of the four engines cannot run, and
/// what to call each of them.
pub fn unportable(pattern: &str) -> Option<&'static str> {
    if Regex::new(r"\\\d").unwrap().is_match(pattern) {
        return Some("a backreference");
    }
    if pattern.contains("(?=") || pattern.contains("(?!") {
        return Some("a lookahead");
    }
    if pattern.contains("(?<=") || pattern.contains("(?<!") {
        return Some("a lookbehind");
    }
    None
}

/// Why a pair could not be compared at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompareError {
    pub code: Option<String>,
    pub message: String,
}

impl CompareError {
    fn plain(message: impl Into<String>) -> Self {
        CompareError {
            code: None,
            message: message.into(),
        }
    }

    fn coded(code: &str, message: impl Into<String>) -> Self {
        CompareError {
            code: Some(code.to_string()),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CompareError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.code {
            Some(code) => write!(out, "{code}: {}", self.message),
            None => out.write_str(&self.message),
        }
    }
}

fn number_or(value: &Value, side: &str, operator: &str) -> Result<f64, CompareError> {
    values::as_number(value).ok_or_else(|| {
        CompareError::plain(format!(
            "{operator} compares numbers, and the {side} is '{}', which is not one.",
            values::to_text(value)
        ))
    })
}

fn is_list(value: &Value) -> bool {
    matches!(value, Value::Array(_))
}

/// One operator against one actual value.
pub fn compare(
    operator: &str,
    actual: &Value,
    expected: &Value,
    present: bool,
) -> Result<bool, CompareError> {
    let wanted = || values::to_text(expected);
    let subject = || values::to_text(actual);
    match operator {
        "equals" => Ok(subject().eq_ignore_ascii_case(&wanted())),
        "notEquals" => Ok(!subject().eq_ignore_ascii_case(&wanted())),
        "contains" => Ok(match actual {
            Value::Array(items) => items.iter().any(|item| values::to_text(item) == wanted()),
            _ => subject().to_lowercase().contains(&wanted().to_lowercase()),
        }),
        "notContains" => Ok(!compare("contains", actual, expected, present)?),
        "startsWith" => Ok(subject().to_lowercase().starts_with(&wanted().to_lowercase())),
        "endsWith" => Ok(subject().to_lowercase().ends_with(&wanted().to_lowercase())),
        "matches" => {
            if let Some(construct) = unportable(&wanted()) {
                return Err(CompareError::coded(
                    "E308",
                    format!(
                        "the pattern '{}' uses {construct}, which is outside the subset the four bindings share.",
                        wanted()
                    ),
                ));
            }
            // Case-insensitive, which is what the suites were written against.
            let pattern = Regex::new(&format!("(?i){}", wanted()))
                .map_err(|failure| CompareError::plain(format!("the pattern '{}' cannot be read: {failure}", wanted())))?;
            Ok(pattern.is_match(&subject()))
        }
        "in" => {
            if !is_list(expected) {
                return Err(CompareError::plain(format!(
                    "in takes a list, and '{}' is not one.",
                    wanted()
                )));
            }
            Ok(expected
                .as_array()
                .unwrap()
                .iter()
                .any(|candidate| values::to_text(candidate).eq_ignore_ascii_case(&subject())))
        }
        "gt" => Ok(number_or(actual, "subject", "gt")? > number_or(expected, "expected value", "gt")?),
        "gte" => Ok(number_or(actual, "subject", "gte")? >= number_or(expected, "expected value", "gte")?),
        "lt" => Ok(number_or(actual, "subject", "lt")? < number_or(expected, "expected value", "lt")?),
        "lte" => Ok(number_or(actual, "subject", "lte")? <= number_or(expected, "expected value", "lte")?),
        "count" => {
            let items = match actual {
                Value::Array(items) => items,
                _ => {
                    return Err(CompareError::plain(format!(
                        "count takes a list, and the subject is '{}', which is not one.",
                        subject()
                    )))
                }
            };
            let wanted = number_or(expected, "expected value", "count")?;
            Ok(items.len() as f64 == wanted)
        }
        "isTrue" => Ok(matches!(actual, Value::Bool(true)) == truth_of(expected)),
        "isFalse" => Ok(matches!(actual, Value::Bool(false)) == truth_of(expected)),
        "isNull" => Ok((!present || actual.is_null()) == truth_of(expected)),
        "isNotNull" => Ok((present && !actual.is_null()) == truth_of(expected)),
        other => Err(CompareError::plain(format!("Unknown assertion: {other}"))),
    }
}

/// What an operator's own expected value means when it is a flag.
fn truth_of(value: &Value) -> bool {
    match value {
        Value::Bool(yes) => *yes,
        Value::Null => false,
        other => !values::to_text(other).is_empty() && values::to_text(other) != "0",
    }
}

/// What a failed assertion says: the subject, the operator, what was expected
/// and what was there.
pub fn describe(
    subject: &str,
    operator: &str,
    expected: &Value,
    actual: &Value,
    present: bool,
) -> String {
    let shown = if !present {
        "(absent)".to_string()
    } else if actual.is_null() {
        "(null)".to_string()
    } else if let Value::Array(items) = actual {
        format!(
            "[{}]",
            items.iter().map(values::to_text).collect::<Vec<String>>().join(", ")
        )
    } else {
        values::to_text(actual)
    };
    let wanted = if let Value::Array(items) = expected {
        format!(
            "[{}]",
            items.iter().map(values::to_text).collect::<Vec<String>>().join(", ")
        )
    } else {
        values::to_text(expected)
    };
    match operator {
        "isTrue" => format!("expected {subject} to be true, got '{shown}'"),
        "isFalse" => format!("expected {subject} to be false, got '{shown}'"),
        "isNull" => format!("expected {subject} to be absent or null, got '{shown}'"),
        "isNotNull" => format!("expected {subject} to be present, got '{shown}'"),
        "count" => format!("expected {subject} to have {wanted} entries, got '{shown}'"),
        _ => format!("expected {subject} {operator} '{wanted}', got '{shown}'"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn equals_compares_as_text_ignoring_case() {
        assert!(compare("equals", &json!("Up"), &json!("up"), true).unwrap());
        assert!(compare("equals", &json!(3), &json!("3"), true).unwrap());
        assert!(!compare("equals", &json!("Up"), &json!("Down"), true).unwrap());
    }

    #[test]
    fn a_list_contains_by_membership_and_a_string_by_substring() {
        assert!(compare("contains", &json!(["N1", "N2"]), &json!("N2"), true).unwrap());
        assert!(!compare("contains", &json!(["N1"]), &json!("N9"), true).unwrap());
        assert!(compare("contains", &json!("HOST-N1"), &json!("n1"), true).unwrap());
    }

    #[test]
    fn an_unportable_pattern_is_refused_with_its_code() {
        let refused = compare("matches", &json!("aa"), &json!(r"(a)\1"), true).unwrap_err();
        assert_eq!(refused.code.as_deref(), Some("E308"));
        assert_eq!(unportable("a(?=b)"), Some("a lookahead"));
        assert_eq!(unportable("(?<=a)b"), Some("a lookbehind"));
        assert_eq!(unportable("^HOST-N[0-9]+$"), None);
    }

    #[test]
    fn absent_and_null_are_the_same_to_one_operator_and_to_nothing_else() {
        assert!(compare("isNull", &Value::Null, &json!(true), true).unwrap());
        assert!(compare("isNull", &Value::Null, &json!(true), false).unwrap());
        assert!(!compare("isNotNull", &json!("Up"), &json!(true), false).unwrap());
        assert!(compare("isNotNull", &json!(""), &json!(true), true).unwrap());
    }

    #[test]
    fn a_failure_names_all_four_parts_of_itself() {
        assert_eq!(
            describe("cs.State", "equals", &json!("Paused"), &json!("Up"), true),
            "expected cs.State equals 'Paused', got 'Up'"
        );
        assert_eq!(
            describe("cs.Nodes", "count", &json!(3), &json!(["N1"]), true),
            "expected cs.Nodes to have 3 entries, got '[N1]'"
        );
        assert!(describe("x", "isNull", &json!(true), &Value::Null, false).contains("(absent)"));
        assert!(describe("x", "isTrue", &json!(true), &Value::Null, true).contains("(null)"));
        assert!(describe("x", "in", &json!(["a"]), &json!("b"), true).contains("[a]"));
    }

    #[test]
    fn an_operator_nobody_implements_is_refused() {
        assert!(compare("isNearly", &json!(3), &json!(3), true).is_err());
        assert!(operators().contains(&"script"));
    }
}
