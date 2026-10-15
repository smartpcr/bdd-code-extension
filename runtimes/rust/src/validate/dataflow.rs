//! `E301` to `E309`, `W301` and `W303`: every reference resolves, every path
//! into a capture is one the action declares, and nothing is captured for
//! nobody.
//!
//! This pass needs the case *expanded* - the suite setup, the hooks and the
//! case's own phases in the order they run - because whether a capture exists
//! yet depends on when the step that produces it runs.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::diag::Diagnostic;
use crate::expr;
use crate::model::{self, Document};
use crate::schema::Schema;
use crate::spelling;
use crate::validate::semantics::Library;
use crate::walk::{self, StepEntry};

/// The bare names the core's run context holds that are not a bag of their
/// own; a runtime extension adds its own context keys.
const CORE_CONTEXT_KEYS: [&str; 2] = ["timeoutSec", "defaults"];

fn text_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn keys_of(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_object)
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default()
}

fn array_of<'a>(value: &'a Value, key: &str) -> Vec<&'a Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|list| list.iter().collect())
        .unwrap_or_default()
}

fn present(value: Option<&Value>) -> bool {
    matches!(value, Some(found) if !found.is_null())
}

/// Where a capture comes from, and when.
#[derive(Debug, Clone)]
struct Produced {
    order: i64,
    action: String,
    pointer: String,
    /// A step that carries a table runs once per row and publishes a list, so a
    /// path into that capture starts with an index (DEC-Y23).
    list: bool,
}

/// One value to look for references in, and what is in scope where it is.
struct Check {
    value: Value,
    pointer: String,
    order: i64,
    in_meta: bool,
    columns: Vec<String>,
}

/// One case as the ordered phases the runner executes it in.
fn case_plan(model: &Value, case: &Value, case_index: usize) -> Vec<StepEntry> {
    let mut plan = Vec::new();
    let mut add = |list: Option<&Vec<Value>>, pointer: &str, phase: &str, base: i64| {
        for mut entry in walk::step_entries(list, pointer, phase) {
            entry.order += base;
            plan.push(entry);
        }
    };
    add(model.get("setup").and_then(Value::as_array), "/setup", "suite setup", -4000);
    add(model.get("beforeEach").and_then(Value::as_array), "/beforeEach", "beforeEach", -3000);
    add(case.get("setup").and_then(Value::as_array), &format!("/tests/{case_index}/setup"), "case setup", -2000);
    add(case.get("steps").and_then(Value::as_array), &format!("/tests/{case_index}/steps"), "steps", 0);
    add(case.get("cleanup").and_then(Value::as_array), &format!("/tests/{case_index}/cleanup"), "cleanup", 100_000);
    add(model.get("afterEach").and_then(Value::as_array), "/afterEach", "afterEach", 200_000);
    // The suite teardown is deliberately absent: it runs once, after the last
    // case, and reads the suite bag rather than any case copy (design 5.3).
    plan
}

/// What a walk into a declared capture shape found.
struct ShapeResult {
    ok: bool,
    expected: String,
    candidates: Vec<String>,
}

/// `E302`: a dotted path has to exist in the shape its action declares.
///
/// The walk stops as soon as the shape is open or untyped, which is the honest
/// answer for an API response: the path may well be there, and the catalog is
/// not the place that knows.
fn walk_shape(shape: Option<&Value>, segments: &[String]) -> ShapeResult {
    let mut current = shape.cloned();
    for segment in segments {
        let node = match &current {
            Some(node) if !node.is_null() => node.clone(),
            _ => return ShapeResult { ok: true, expected: String::new(), candidates: Vec::new() },
        };
        let kind = text_of(&node, "type");
        if kind.is_empty() || kind == "any" {
            return ShapeResult { ok: true, expected: String::new(), candidates: Vec::new() };
        }
        if kind == "array" {
            if segment.parse::<usize>().is_err() && segment != "<index>" {
                return ShapeResult {
                    ok: false,
                    expected: "an index into an array".to_string(),
                    candidates: Vec::new(),
                };
            }
            current = node.get("items").cloned();
            continue;
        }
        if kind != "object" {
            return ShapeResult {
                ok: false,
                expected: format!("a {kind}, which has no {segment} inside it"),
                candidates: Vec::new(),
            };
        }
        // Truthy, not merely present. "additionalProperties: false" is the
        // catalog saying the shape is closed, and reading it as "there is
        // something here" would stop the walk at every closed object.
        if node.get("additionalProperties").and_then(Value::as_bool).unwrap_or(false) {
            return ShapeResult { ok: true, expected: String::new(), candidates: Vec::new() };
        }
        let properties = node.get("properties").cloned();
        let declared = keys_of(properties.as_ref());
        if !declared.contains(segment) {
            return ShapeResult {
                ok: false,
                expected: "not declared".to_string(),
                candidates: declared,
            };
        }
        current = properties.and_then(|map| map.get(segment).cloned());
    }
    ShapeResult { ok: true, expected: String::new(), candidates: Vec::new() }
}

/// `E301`, `E302` and the read that `W301` counts, for one dotted subject.
#[allow(clippy::too_many_arguments)]
fn subject(
    text: &str,
    pointer: &str,
    document: &Document,
    file: &str,
    schema: &Schema,
    produced: &BTreeMap<String, Produced>,
    case_name: &str,
    read: &mut BTreeSet<String>,
    at_key: bool,
) -> Vec<Diagnostic> {
    let mut found = Vec::new();
    let segments: Vec<String> = text.split('.').map(str::to_string).collect();
    let name = segments[0].clone();
    read.insert(name.clone());
    let node = document.at(pointer);
    let position = if at_key { node.key } else { node.value };
    let source = match produced.get(&name) {
        Some(source) => source.clone(),
        None => {
            let names: Vec<String> = produced.keys().cloned().collect();
            let finding = Diagnostic::error(
                "E301",
                file,
                position,
                format!("No step in case {case_name} captures {name}."),
            );
            found.push(match spelling::nearest(&name, &names, 2) {
                Some(nearest) => finding.suggest(nearest),
                None => finding,
            });
            return found;
        }
    };
    let declared = match schema.actions.get(&source.action) {
        Some(declared) => declared,
        None => return found,
    };
    let mut shape = declared.captures.clone();
    if source.list {
        shape = Some(serde_json::json!({ "type": "array", "items": shape }));
    }
    if segments.len() <= 1 {
        return found;
    }
    let result = walk_shape(shape.as_ref(), &segments[1..]);
    if !result.ok {
        let finding = Diagnostic::error(
            "E302",
            file,
            position,
            format!(
                "Action {} does not declare {text} in what it captures.",
                source.action
            ),
        );
        let suggestion = if result.candidates.is_empty() {
            // Nothing to suggest, so the shape says what it wanted instead.
            Some(format!("That path wants {}.", result.expected))
        } else {
            match spelling::nearest(segments.last().unwrap(), &result.candidates, 2) {
                Some(nearest) => Some(format!("Did you mean {nearest}")),
                None => Some(format!("Declared: {}", result.candidates.join(", "))),
            }
        };
        found.push(match suggestion {
            Some(text) => finding.suggest(text),
            None => finding,
        });
    }
    found
}

/// `E308`: a pattern outside the subset the four engines share.
fn portable_pattern(pattern: &str, pointer: &str, document: &Document, file: &str) -> Vec<Diagnostic> {
    match crate::assertions::unportable(pattern) {
        Some(construct) => vec![Diagnostic::error(
            "E308",
            file,
            document.at(pointer).value,
            format!("The pattern uses {construct}, which the Go binding's RE2 engine cannot run."),
        )
        .suggest("Restrict the pattern to the subset RE2 and .NET agree on.")],
        None => Vec::new(),
    }
}

/// The dataflow pass.
pub fn check(
    document: &Document,
    file: &str,
    schema: &Schema,
    library: &Library,
    extra_context_keys: &[String],
) -> Vec<Diagnostic> {
    let mut found: Vec<Diagnostic> = Vec::new();
    let model = &document.value;
    let context_keys: Vec<String> = CORE_CONTEXT_KEYS
        .iter()
        .map(|key| key.to_string())
        .chain(extra_context_keys.iter().cloned())
        .collect();

    let mut declared_params: BTreeSet<String> = library.params.keys().cloned().collect();
    for param in array_of(model, "params") {
        if !param.is_null() {
            declared_params.insert(text_of(param, "name"));
        }
    }
    let mut suite_vars: BTreeSet<String> = library.vars.keys().cloned().collect();
    suite_vars.extend(keys_of(model.get("vars")));
    let mut read_params: BTreeSet<String> = BTreeSet::new();

    // Every capture name the file produces anywhere. A bare name that is one of
    // these is a reference written without its root, and the message can say
    // both halves of it.
    let mut file_captures: BTreeSet<String> = BTreeSet::new();
    for entry in walk::all_steps(model) {
        let name = text_of(&entry.step, "captureAs");
        if !name.is_empty() {
            file_captures.insert(name);
        }
    }

    for (case_index, case) in array_of(model, "tests").into_iter().enumerate() {
        if case.is_null() {
            continue;
        }
        let case_name = text_of(case, "name");
        let plan = case_plan(model, case, case_index);
        let mut case_vars = suite_vars.clone();
        case_vars.extend(keys_of(case.get("vars")));
        for param in array_of(case, "params") {
            if !param.is_null() {
                declared_params.insert(text_of(param, "name"));
            }
        }

        let mut produced: BTreeMap<String, Produced> = BTreeMap::new();
        for entry in &plan {
            let name = text_of(&entry.step, "captureAs");
            if name.is_empty() {
                continue;
            }
            let better = match produced.get(&name) {
                Some(existing) => entry.order < existing.order,
                None => true,
            };
            if better {
                produced.insert(
                    name,
                    Produced {
                        order: entry.order,
                        action: text_of(&entry.step, "action"),
                        pointer: entry.pointer.clone(),
                        list: present(entry.step.get("table")),
                    },
                );
            }
        }

        // A meta use site publishes what its definition exports, under the
        // names the definition gave them. The action is left blank because the
        // export's shape belongs to whichever step inside produced it, and a
        // use site cannot rename it (DEC-Y10).
        for entry in &plan {
            let used = text_of(&entry.step, "meta");
            if used.is_empty() {
                continue;
            }
            let definition = array_of(model, "metaSteps")
                .into_iter()
                .find(|meta| text_of(meta, "name") == used)
                .cloned()
                .or_else(|| library.meta_steps.get(&used).cloned());
            let definition = match definition {
                Some(definition) => definition,
                None => continue,
            };
            for export in array_of(&definition, "exports") {
                let name = export.as_str().unwrap_or_default().to_string();
                if name.is_empty() {
                    continue;
                }
                produced.insert(
                    name,
                    Produced {
                        order: entry.order,
                        action: String::new(),
                        pointer: entry.pointer.clone(),
                        list: false,
                    },
                );
            }
        }

        let case_columns = walk::table_columns(case.get("examples"));
        let mut read: BTreeSet<String> = BTreeSet::new();
        let mut checks: Vec<Check> = Vec::new();
        for entry in &plan {
            let mut columns = case_columns.clone();
            columns.extend(walk::table_columns(entry.step.get("table")));
            checks.push(Check {
                value: entry.step.clone(),
                pointer: entry.pointer.clone(),
                order: entry.order,
                in_meta: entry.phase.starts_with("meta "),
                columns,
            });
            let mut guard = text_of(&entry.step, "ifCapture");
            if !produced.contains_key(&guard) { guard = guard.split('.').next().unwrap_or_default().to_string(); }
            if !guard.is_empty() {
                // A guard may name a capture that is not there yet: that is the
                // whole point of it. So this is an existence check and never an
                // ordering one. A name no step in the case declares at all is a
                // typo, and a typo here silently disables a cleanup step.
                read.insert(guard.clone());
                if !produced.contains_key(&guard) {
                    let names: Vec<String> = produced.keys().cloned().collect();
                    let finding = Diagnostic::error(
                        "E301",
                        file,
                        document.at(&format!("{}/ifCapture", entry.pointer)).value,
                        format!("ifCapture names {guard}, which no step in case {case_name} captures."),
                    );
                    found.push(match spelling::nearest(&guard, &names, 2) {
                        Some(nearest) => finding.suggest(nearest),
                        None => finding,
                    });
                }
            }
        }

        // A case's own assertions read anything the case produced; a step's own
        // assertions read anything up to and including that step.
        let add_assertions = |assertions: Option<&Value>,
                                  pointer: String,
                                  order: i64,
                                  columns: Vec<String>,
                                  visible: &BTreeMap<String, Produced>,
                                  checks: &mut Vec<Check>,
                                  read: &mut BTreeSet<String>|
         -> Vec<Diagnostic> {
            let mut found = Vec::new();
            for (index, assertion) in assertions
                .and_then(Value::as_array)
                .map(|list| list.iter().enumerate().collect::<Vec<_>>())
                .unwrap_or_default()
            {
                if !assertion.is_object() {
                    continue;
                }
                checks.push(Check {
                    value: assertion.clone(),
                    pointer: format!("{pointer}/{index}"),
                    order,
                    in_meta: false,
                    columns: columns.clone(),
                });
                let var = text_of(assertion, "var");
                if !var.is_empty() {
                    found.extend(subject(
                        &var,
                        &format!("{pointer}/{index}/var"),
                        document,
                        file,
                        schema,
                        visible,
                        &case_name,
                        read,
                        false,
                    ));
                }
                let pattern = text_of(assertion, "matches");
                if !pattern.is_empty() {
                    found.extend(portable_pattern(
                        &pattern,
                        &format!("{pointer}/{index}/matches"),
                        document,
                        file,
                    ));
                }
                // A script assertion reads the bag directly, so what it names is
                // read even though it is not a ${...} reference.
                let script = text_of(assertion, "script");
                for piece in script.split("capture.").skip(1) {
                    let name: String = piece
                        .chars()
                        .take_while(|character| character.is_alphanumeric() || *character == '_')
                        .collect();
                    if !name.is_empty() {
                        read.insert(name);
                    }
                }
            }
            found
        };

        found.extend(add_assertions(
            case.get("asserts"),
            format!("/tests/{case_index}/asserts"),
            99_999,
            case_columns.clone(),
            &produced,
            &mut checks,
            &mut read,
        ));
        for entry in &plan {
            if !present(entry.step.get("asserts")) {
                continue;
            }
            // Inside a table step's own assertions the capture is that row's
            // result, not the list the step publishes afterwards.
            let mut visible = produced.clone();
            let own = text_of(&entry.step, "captureAs");
            if present(entry.step.get("table")) && !own.is_empty() {
                if let Some(source) = visible.get_mut(&own) {
                    source.list = false;
                }
            }
            let mut columns = case_columns.clone();
            columns.extend(walk::table_columns(entry.step.get("table")));
            found.extend(add_assertions(
                entry.step.get("asserts"),
                format!("{}/asserts", entry.pointer),
                entry.order + 1,
                columns,
                &visible,
                &mut checks,
                &mut read,
            ));
        }

        for check in &checks {
            for (pointer, expression) in expr::references(&check.value, &check.pointer) {
                let position = document.at(&pointer).value;
                let reading = expr::read(&expression, false);
                if let Some(failure) = reading.error {
                    let suggestion = failure
                        .message
                        .split_once("Did you mean ")
                        .map(|(_, rest)| format!("Did you mean {}", rest.trim_end_matches(['?', '.'])));
                    let finding = Diagnostic::error(
                        &failure.code,
                        file,
                        position,
                        format!("${{{expression}}} does not parse: {}.", failure.message),
                    );
                    found.push(match suggestion {
                        Some(text) if failure.code == "E306" => finding.suggest(text),
                        _ => finding,
                    });
                    continue;
                }
                for segments in reading.paths {
                    let whole = segments.join(".");
                    let root = segments[0].as_str();
                    match root {
                        "capture" => {
                            if segments.len() < 2 {
                                found.push(Diagnostic::error(
                                    "E301",
                                    file,
                                    position,
                                    "A capture reference needs a name: ${capture.<name>}.",
                                ));
                                continue;
                            }
                            let name = segments[1].clone();
                            read.insert(name.clone());
                            let source = match produced.get(&name) {
                                Some(source) => source.clone(),
                                None => {
                                    let names: Vec<String> = produced.keys().cloned().collect();
                                    let finding = Diagnostic::error(
                                        "E301",
                                        file,
                                        position,
                                        format!("No step in case {case_name} captures {name}."),
                                    );
                                    found.push(match spelling::nearest(&name, &names, 2) {
                                        Some(nearest) => finding.suggest(nearest),
                                        None => finding,
                                    });
                                    continue;
                                }
                            };
                            if source.order >= check.order {
                                found.push(Diagnostic::error(
                                    "E303",
                                    file,
                                    position,
                                    format!("Capture {name} is read before the step that produces it."),
                                ));
                                continue;
                            }
                            found.extend(subject(
                                &segments[1..].join("."),
                                &pointer,
                                document,
                                file,
                                schema,
                                &produced,
                                &case_name,
                                &mut read,
                                false,
                            ));
                        }
                        "param" => {
                            if segments.len() < 2 {
                                continue;
                            }
                            read_params.insert(segments[1].clone());
                            // A meta step's parameter is resolved at its use site.
                            if check.in_meta {
                                continue;
                            }
                            if !declared_params.contains(&segments[1]) {
                                let names: Vec<String> = declared_params.iter().cloned().collect();
                                let finding = Diagnostic::error(
                                    "E301",
                                    file,
                                    position,
                                    format!("No parameter named {} is declared or imported.", segments[1]),
                                );
                                found.push(match spelling::nearest(&segments[1], &names, 2) {
                                    Some(nearest) => finding.suggest(nearest),
                                    None => finding,
                                });
                            }
                        }
                        "var" => {
                            if segments.len() < 2 {
                                continue;
                            }
                            if !case_vars.contains(&segments[1]) {
                                let names: Vec<String> = case_vars.iter().cloned().collect();
                                let finding = Diagnostic::error(
                                    "E301",
                                    file,
                                    position,
                                    format!("No variable named {} is declared.", segments[1]),
                                );
                                found.push(match spelling::nearest(&segments[1], &names, 2) {
                                    Some(nearest) => finding.suggest(nearest),
                                    None => finding,
                                });
                            }
                        }
                        "defaults" => {
                            if segments.len() < 2 {
                                continue;
                            }
                            let declared = keys_of(model.get("defaults"));
                            if !declared.contains(&segments[1]) {
                                found.push(Diagnostic::error(
                                    "E301",
                                    file,
                                    position,
                                    format!("The defaults block declares no {}.", segments[1]),
                                ));
                            }
                        }
                        "row" => {
                            if check.columns.is_empty() {
                                found.push(Diagnostic::error(
                                    "E301",
                                    file,
                                    position,
                                    "${row} has no table in scope. A row exists inside a step that carries a table, or a case that carries examples.",
                                ));
                                continue;
                            }
                            if segments.len() < 2 {
                                found.push(
                                    Diagnostic::error(
                                        "E301",
                                        file,
                                        position,
                                        "A row reference needs a column: ${row.<column>}.",
                                    )
                                    .suggest(format!("Declared: {}", check.columns.join(", "))),
                                );
                                continue;
                            }
                            if !check.columns.contains(&segments[1]) {
                                let finding = Diagnostic::error(
                                    "E301",
                                    file,
                                    position,
                                    format!("The table in scope declares no column {}.", segments[1]),
                                );
                                found.push(match spelling::nearest(&segments[1], &check.columns, 2) {
                                    Some(nearest) => finding.suggest(nearest),
                                    None => finding,
                                });
                            }
                        }
                        _ => {
                            if context_keys.iter().any(|key| key == root) && segments.len() == 1 {
                                continue;
                            }
                            let suggestion = if produced.contains_key(root) {
                                Some(format!("Captures are read as ${{capture.{whole}}}."))
                            } else if file_captures.contains(root) {
                                Some(format!(
                                    "Captures are read as ${{capture.{whole}}}, and only in the case that captured {root}. Capture it in case {case_name} too."
                                ))
                            } else {
                                let mut candidates: Vec<String> = context_keys.clone();
                                candidates.extend(["capture", "param", "var"].map(str::to_string));
                                spelling::nearest(root, &candidates, 2).map(|nearest| format!("Did you mean {nearest}"))
                            };
                            let finding = Diagnostic::error(
                                "E301",
                                file,
                                position,
                                format!("${{{whole}}} resolves to nothing. A path starts at capture, param, var or a context key."),
                            );
                            found.push(match suggestion {
                                Some(text) => finding.suggest(text),
                                None => finding,
                            });
                        }
                    }
                }
            }
        }

        // W301: a capture nothing reads is a step whose result nobody checked.
        for (name, source) in &produced {
            if read.contains(name) {
                continue;
            }
            if !source.pointer.starts_with(&format!("/tests/{case_index}/")) {
                continue;
            }
            found.push(Diagnostic::warning(
                "W301",
                file,
                document.at(&format!("{}/captureAs", source.pointer)).value,
                format!("Capture {name} in case {case_name} is never read by a later step, an assertion or a cleanup."),
            ));
        }
    }

    // E304: a meta step promising an export no step of it captures.
    for (meta_index, meta) in array_of(model, "metaSteps").into_iter().enumerate() {
        if meta.is_null() {
            continue;
        }
        let captured: Vec<String> = array_of(meta, "steps")
            .into_iter()
            .map(|step| text_of(step, "captureAs"))
            .filter(|name| !name.is_empty())
            .collect();
        for (export_index, export) in array_of(meta, "exports").into_iter().enumerate() {
            let name = export.as_str().unwrap_or_default().to_string();
            if name.is_empty() || captured.contains(&name) {
                continue;
            }
            let finding = Diagnostic::error(
                "E304",
                file,
                document
                    .at(&format!("/metaSteps/{meta_index}/exports/{export_index}"))
                    .value,
                format!(
                    "Meta step {} exports {name}, which none of its steps captures.",
                    text_of(meta, "name")
                ),
            );
            found.push(match spelling::nearest(&name, &captured, 2) {
                Some(nearest) => finding.suggest(nearest),
                None => finding,
            });
        }
    }

    // E309: a vars value has to be the same on every run, because a conformance
    // run compares it. Only the determinism rule is checked on a var: its paths
    // resolve against parameters and other vars rather than a case's captures.
    let mut var_blocks: Vec<(String, Option<&Value>)> = vec![("/vars".to_string(), model.get("vars"))];
    for (index, case) in array_of(model, "tests").into_iter().enumerate() {
        if !case.is_null() && present(case.get("vars")) {
            var_blocks.push((format!("/tests/{index}/vars"), case.get("vars")));
        }
    }
    for (pointer, block) in var_blocks {
        for name in keys_of(block) {
            let value = block.and_then(|map| map.get(&name)).cloned().unwrap_or(Value::Null);
            for (at, expression) in expr::references(&value, &format!("{pointer}/{}", model::escape(&name))) {
                let reading = expr::read(&expression, true);
                if let Some(failure) = reading.error {
                    if failure.code == "E309" {
                        found.push(
                            Diagnostic::error(
                                "E309",
                                file,
                                document.at(&at).value,
                                format!("${{{expression}}} cannot be used in vars: {}.", failure.message),
                            )
                            .suggest("Pass the value in with --param, or capture it in a step where a changing value is fine."),
                        );
                    }
                }
            }
        }
    }

    // W303: a declared parameter nothing reads.
    for (index, param) in array_of(model, "params").into_iter().enumerate() {
        if param.is_null() {
            continue;
        }
        let name = text_of(param, "name");
        if !read_params.contains(&name) {
            found.push(Diagnostic::warning(
                "W303",
                file,
                document.at(&format!("/params/{index}/name")).value,
                format!("Parameter {name} is declared and never read."),
            ));
        }
    }

    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_walk_stops_where_the_shape_opens() {
        let open = json!({ "type": "any" });
        assert!(walk_shape(Some(&open), &["anything".to_string()]).ok);
        assert!(walk_shape(None, &["anything".to_string()]).ok);
        let closed = json!({ "type": "object", "properties": { "State": { "type": "string" } } });
        assert!(walk_shape(Some(&closed), &["State".to_string()]).ok);
        let refused = walk_shape(Some(&closed), &["Nope".to_string()]);
        assert!(!refused.ok);
        assert_eq!(refused.candidates, vec!["State".to_string()]);
    }

    #[test]
    fn a_list_needs_an_index_and_a_scalar_has_nothing_inside_it() {
        let list = json!({ "type": "array", "items": { "type": "string" } });
        assert!(walk_shape(Some(&list), &["0".to_string()]).ok);
        assert!(!walk_shape(Some(&list), &["name".to_string()]).ok);
        let scalar = json!({ "type": "string" });
        let refused = walk_shape(Some(&scalar), &["length".to_string()]);
        assert!(!refused.ok);
        assert!(refused.expected.contains("string"));
    }

    #[test]
    fn an_open_object_accepts_whatever_comes_back() {
        let open = json!({ "type": "object", "additionalProperties": true });
        assert!(walk_shape(Some(&open), &["whatever".to_string()]).ok);
    }

    #[test]
    fn the_plan_runs_the_hooks_around_the_case() {
        let model = json!({
            "setup": [{ "action": "core.noop" }],
            "beforeEach": [{ "action": "core.noop" }],
            "afterEach": [{ "action": "core.noop" }],
            "tests": [{ "name": "c", "setup": [{ "action": "core.noop" }], "steps": [{ "action": "core.noop" }], "cleanup": [{ "action": "core.noop" }] }],
        });
        let plan = case_plan(&model, &model["tests"][0], 0);
        let phases: Vec<String> = plan.iter().map(|entry| entry.phase.clone()).collect();
        assert_eq!(
            phases,
            vec!["suite setup", "beforeEach", "case setup", "steps", "cleanup", "afterEach"]
        );
        let orders: Vec<i64> = plan.iter().map(|entry| entry.order).collect();
        let mut sorted = orders.clone();
        sorted.sort();
        assert_eq!(orders, sorted, "the plan is already in the order it runs");
    }
}
