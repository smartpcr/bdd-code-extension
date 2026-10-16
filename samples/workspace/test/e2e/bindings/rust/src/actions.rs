//! The shop's actions, Rust binding. Every handler is small and
//! deterministic, and returns what the other four bindings return for the same
//! step, so one suite gives one result everywhere.

use serde_json::{json, Value};
use suiterun::actions::{ActionError, Outcome, Request};
use suiterun::Action;

/// Every action this binding implements.
pub fn actions() -> Vec<Action> {
    vec![
        Action::new("inventory.get", inventory_get),
        Action::new("cart.add", cart_add),
        Action::new("price.quote", price_quote),
        Action::new("stock.reserve", stock_reserve),
        Action::new("shipping.quote", shipping_quote),
        Action::new("customer.lookup", customer_lookup),
        Action::new("audit.log", audit_log),
    ]
}

/// A parameter as text, or nothing when it is absent or empty.
fn given(request: &Request, name: &str) -> Option<String> {
    match request.step.get(name) {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => Some(other.to_string()),
    }
}

/// A required text parameter.
fn text(request: &Request, name: &str) -> Result<String, ActionError> {
    given(request, name).ok_or_else(|| ActionError::action(format!("{} needs a {name}.", request.action)))
}

/// An integer parameter, given as a number or as a numeric string.
fn integer(request: &Request, name: &str, fallback: i64) -> Result<i64, ActionError> {
    match request.step.get(name) {
        None | Some(Value::Null) => Ok(fallback),
        Some(Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|f| f as i64))
            .ok_or_else(|| ActionError::action(format!("{}: {name} is not a whole number.", request.action))),
        Some(other) => {
            let raw = match other {
                Value::String(text) => text.trim().to_string(),
                _ => other.to_string(),
            };
            raw.parse::<i64>()
                .map_err(|_| ActionError::action(format!("{}: {name} is not a whole number.", request.action)))
        }
    }
}

fn sku_and_quantity(request: &Request) -> Result<(String, i64), ActionError> {
    Ok((text(request, "sku")?, integer(request, "quantity", 1)?))
}

fn inventory_get(request: &Request) -> Outcome {
    let sku = text(request, "sku")?;
    let quantity = (sku.len() as i64) * 10;
    Ok(json!({ "sku": sku, "quantity": quantity, "inStock": true }))
}

fn cart_add(request: &Request) -> Outcome {
    let (sku, quantity) = sku_and_quantity(request)?;
    Ok(json!({ "sku": sku, "quantity": quantity, "line": format!("{sku}x{quantity}") }))
}

fn price_quote(request: &Request) -> Outcome {
    let (sku, quantity) = sku_and_quantity(request)?;
    Ok(json!({ "sku": sku, "total": quantity * 3 }))
}

fn stock_reserve(request: &Request) -> Outcome {
    let (sku, quantity) = sku_and_quantity(request)?;
    Ok(json!({ "sku": sku, "reserved": quantity }))
}

fn shipping_quote(request: &Request) -> Outcome {
    let weight = integer(request, "weightKg", 0)?;
    if weight <= 0 {
        return Err(ActionError::action("shipping.quote needs a weightKg above zero."));
    }
    let policy = given(request, "policy").unwrap_or_else(|| "Standard".to_string());
    let rate = match policy.as_str() {
        "Standard" => 5,
        "Express" => 10,
        other => return Err(ActionError::action(format!("shipping.quote: unknown policy {other}."))),
    };
    Ok(json!({ "policy": policy, "cost": weight * rate }))
}

fn customer_lookup(request: &Request) -> Outcome {
    let id = text(request, "id")?;
    let tier = if id.starts_with('G') { "gold" } else { "standard" };
    Ok(json!({ "id": id, "name": format!("Customer {id}"), "tier": tier }))
}

fn audit_log(request: &Request) -> Outcome {
    text(request, "message")?;
    Ok(json!({ "logged": true }))
}
