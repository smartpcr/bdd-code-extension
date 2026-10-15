//! One value as the text every binding writes it as.
//!
//! A suite compares values that arrived as YAML, as JSON from an API, and as
//! whatever an action returned. The rules here are what keeps `equals` meaning
//! the same thing in four languages: a whole number never grows a `.0`, a
//! boolean is lowercase, and nothing at all is the empty string rather than the
//! word null.

use serde_json::Value;

/// A value as text.
pub fn to_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(true) => "true".to_string(),
        Value::Bool(false) => "false".to_string(),
        Value::String(text) => text.clone(),
        Value::Number(number) => number_text(number),
        Value::Array(items) => items
            .iter()
            .map(to_text)
            .collect::<Vec<String>>()
            .join(", "),
        Value::Object(_) => serde_json::to_string(value).unwrap_or_default(),
    }
}

/// A number as text: whole numbers keep no decimal part, and a fraction keeps
/// the shortest spelling that reads back as itself.
pub fn number_text(number: &serde_json::Number) -> String {
    if let Some(whole) = number.as_i64() {
        return whole.to_string();
    }
    if let Some(fraction) = number.as_f64() {
        if fraction.fract() == 0.0 && fraction.abs() < 9.2e18 {
            return format!("{}", fraction as i64);
        }
        return format!("{fraction}");
    }
    number.to_string()
}

/// Whether two values are the same number, when both are numbers.
pub fn as_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_value_reads_as_the_text_four_bindings_write() {
        assert_eq!(to_text(&Value::Null), "");
        assert_eq!(to_text(&json!(true)), "true");
        assert_eq!(to_text(&json!(false)), "false");
        assert_eq!(to_text(&json!("x")), "x");
        assert_eq!(to_text(&json!(3)), "3");
        assert_eq!(to_text(&json!(3.0)), "3");
        assert_eq!(to_text(&json!(3.5)), "3.5");
        assert_eq!(to_text(&json!(-2)), "-2");
        assert_eq!(to_text(&json!(["a", "b"])), "a, b");
        assert_eq!(to_text(&json!({ "a": 1 })), "{\"a\":1}");
    }

    #[test]
    fn a_number_comes_out_of_text_when_it_is_one() {
        assert_eq!(as_number(&json!(3)), Some(3.0));
        assert_eq!(as_number(&json!("3.5")), Some(3.5));
        assert_eq!(as_number(&json!(" 4 ")), Some(4.0));
        assert_eq!(as_number(&json!("x")), None);
        assert_eq!(as_number(&Value::Null), None);
        assert_eq!(as_number(&json!(true)), None);
    }
}
