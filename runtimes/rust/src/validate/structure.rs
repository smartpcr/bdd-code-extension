//! `E100` to `E105`: the file parses, its keys are spelled and typed the way
//! the schema says, and every step's parameters belong to its action.
//!
//! Two passes, for the reason DEC-Y05 gives. The first checks the whole
//! document against the generated schema with the step union swapped for the
//! envelope, because a validator that reports every unselected branch of a
//! union reports four problems where there is one. The second checks each step
//! against the one branch its action selects, so an unknown parameter is
//! `E105` and names the action rather than being one of four "no branch
//! matched" messages.

use serde_json::{json, Map, Value};

use crate::diag::{Diagnostic, Position};
use crate::model::Document;
use crate::schema::Schema;
use crate::spelling;
use crate::walk::{self, StepEntry};

/// One thing the schema refused, at the pointer it refused it.
#[derive(Debug, Clone)]
struct SchemaFailure {
    pointer: String,
    kind: FailureKind,
}

#[derive(Debug, Clone)]
enum FailureKind {
    /// A key the object has to carry and does not.
    Required(String),
    /// A key nothing declares, at the pointer of the key itself.
    Unexpected(String),
    /// Anything else: a wrong type, a value outside its range, a string that
    /// does not match. One message, at the value.
    Refused(String),
}

/// A pointer as something a suite author recognises.
fn pointer_name(pointer: &str) -> String {
    if pointer.is_empty() {
        "the suite".to_string()
    } else {
        format!("the suite at {pointer}")
    }
}

fn keys_of(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_object)
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default()
}

/// What kind of place a pointer names, and which keys are legal there.
///
/// Read out of the schema and the catalog rather than listed here, so a key
/// added to either is offered without this function changing.
struct LegalKeys {
    action: Option<String>,
    keys: Vec<String>,
}

fn legal_keys(pointer: &str, schema: &Schema, step: Option<&StepEntry>) -> LegalKeys {
    if let Some(entry) = step {
        let action = entry.step.get("action").and_then(Value::as_str).unwrap_or("");
        if let Some(declared) = schema.actions.get(action) {
            let mut keys = schema.step_common_keys.clone();
            keys.extend(declared.params.iter().cloned());
            return LegalKeys {
                action: Some(action.to_string()),
                keys,
            };
        }
        return LegalKeys {
            action: None,
            keys: keys_of(schema.defs.get("step.meta").and_then(|meta| meta.get("properties"))),
        };
    }

    let definition = if pointer.is_empty() {
        Some(&schema.document)
    } else if pointer == "/defaults" {
        schema.defs.get("defaults")
    } else if is_shaped(pointer, &["tests", "#"]) {
        schema.defs.get("case")
    } else if is_shaped(pointer, &["tests", "#", "asserts", "#"]) {
        schema.defs.get("assert")
    } else if is_shaped(pointer, &["metaSteps", "#"]) {
        schema.defs.get("metaStep")
    } else if is_shaped(pointer, &["metaSteps", "#", "params", "#"]) {
        schema.defs.get("metaParamDecl")
    } else if pointer.ends_with(|last: char| last.is_ascii_digit()) && pointer.contains("params/") {
        schema.defs.get("paramDecl")
    } else {
        None
    };
    LegalKeys {
        action: None,
        keys: keys_of(definition.and_then(|found| found.get("properties"))),
    }
}

/// Whether a pointer has a given shape, with `#` standing for any index.
fn is_shaped(pointer: &str, shape: &[&str]) -> bool {
    let segments: Vec<&str> = pointer.split('/').skip(1).collect();
    if segments.len() != shape.len() {
        return false;
    }
    segments.iter().zip(shape).all(|(segment, expected)| {
        if *expected == "#" {
            segment.chars().all(|character| character.is_ascii_digit()) && !segment.is_empty()
        } else {
            segment == expected
        }
    })
}

/// Everything one schema refused about one document.
fn failures(schema_document: &Value, instance: &Value) -> Result<Vec<SchemaFailure>, String> {
    let validator = jsonschema::validator_for(schema_document)
        .map_err(|failure| format!("the schema cannot be compiled: {failure}"))?;
    let mut found = Vec::new();
    for error in validator.iter_errors(instance) {
        let pointer = error.instance_path().to_string();
        match error.kind() {
            jsonschema::error::ValidationErrorKind::Required { property } => {
                let name = property.as_str().unwrap_or_default().to_string();
                found.push(SchemaFailure {
                    pointer: pointer.clone(),
                    kind: FailureKind::Required(name),
                });
            }
            jsonschema::error::ValidationErrorKind::AdditionalProperties { unexpected } => {
                for name in unexpected {
                    found.push(SchemaFailure {
                        pointer: format!("{pointer}/{}", crate::model::escape(name)),
                        kind: FailureKind::Unexpected(name.clone()),
                    });
                }
            }
            jsonschema::error::ValidationErrorKind::FalseSchema => {
                let name = pointer.rsplit('/').next().unwrap_or_default().to_string();
                found.push(SchemaFailure {
                    pointer: pointer.clone(),
                    kind: FailureKind::Unexpected(name),
                });
            }
            _ => found.push(SchemaFailure {
                pointer: pointer.clone(),
                kind: FailureKind::Refused(error.to_string()),
            }),
        }
    }
    Ok(found)
}

fn to_diagnostic(
    failure: &SchemaFailure,
    document: &Document,
    file: &str,
    schema: &Schema,
    step: Option<&StepEntry>,
) -> Diagnostic {
    match &failure.kind {
        FailureKind::Required(name) => Diagnostic::error(
            "E102",
            file,
            document.at(&failure.pointer).key,
            format!(
                "Required key {name} is missing from {}.",
                pointer_name(&failure.pointer)
            ),
        ),
        FailureKind::Unexpected(name) => {
            let parent = match failure.pointer.rfind('/') {
                Some(at) => failure.pointer[..at].to_string(),
                None => String::new(),
            };
            let legal = legal_keys(&parent, schema, step);
            let suggestion = spelling::nearest(name, &legal.keys, 2);
            let position = document.at(&failure.pointer).key;
            let finding = match &legal.action {
                Some(action) => Diagnostic::error(
                    "E105",
                    file,
                    position,
                    format!("Action {action} takes no parameter {name}."),
                ),
                None => Diagnostic::error(
                    "E101",
                    file,
                    position,
                    format!("Unknown key {name} in {}.", pointer_name(&parent)),
                ),
            };
            match suggestion {
                Some(nearest) => finding.suggest(format!("Did you mean {nearest}")),
                None => finding,
            }
        }
        FailureKind::Refused(body) => Diagnostic::error(
            "E103",
            file,
            document.at(&failure.pointer).value,
            format!(
                "{} has a value the schema refuses: {body}.",
                pointer_name(&failure.pointer)
            ),
        ),
    }
}

/// The structural pass.
pub fn check(document: &Document, file: &str, schema: &Schema) -> Result<Vec<Diagnostic>, String> {
    let mut found: Vec<Diagnostic> = Vec::new();

    for failure in failures(&schema.document, &document.value)? {
        found.push(to_diagnostic(&failure, document, file, schema, None));
    }

    // One branch per step, selected by its action name.
    let entries = walk::all_steps(&document.value);
    let mut branches: Vec<Value> = Vec::new();
    let mut documents: Vec<Value> = Vec::new();
    let mut checked: Vec<StepEntry> = Vec::new();
    for entry in &entries {
        if !entry.step.is_object() {
            found.push(Diagnostic::error(
                "E103",
                file,
                document.at(&entry.pointer).value,
                "A step must be a mapping with an action.",
            ));
            continue;
        }
        let action = entry.step.get("action").and_then(Value::as_str).unwrap_or("");
        if !action.is_empty() {
            if !schema.actions.contains_key(action) {
                let suggestion = spelling::nearest(action, &schema.action_names, 3);
                let finding = Diagnostic::error(
                    "E104",
                    file,
                    document.at(&format!("{}/action", entry.pointer)).value,
                    format!("Unknown action {action}."),
                );
                found.push(match suggestion {
                    Some(nearest) => finding.suggest(format!("Did you mean {nearest}")),
                    None => finding.suggest(
                        "No action of that name is declared in actions.catalog.yaml.",
                    ),
                });
                continue;
            }
            branches.push(json!({ "$ref": format!("#/$defs/step.{action}") }));
        } else if entry.step.get("meta").is_some_and(|meta| !meta.is_null()) {
            branches.push(json!({ "$ref": "#/$defs/step.meta" }));
        } else {
            found.push(Diagnostic::error(
                "E102",
                file,
                document.at(&entry.pointer).key,
                "A step declares no action and no meta. One of the two is required.",
            ));
            continue;
        }
        documents.push(entry.step.clone());
        checked.push(entry.clone());
    }

    if !checked.is_empty() {
        let mut properties = Map::new();
        properties.insert(
            "steps".to_string(),
            json!({ "type": "array", "prefixItems": branches }),
        );
        let step_schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "properties": Value::Object(properties),
            "$defs": schema.defs,
        });
        let instance = json!({ "steps": documents });
        for failure in failures(&step_schema, &instance)? {
            let rest = failure.pointer.strip_prefix("/steps/").unwrap_or_default();
            let (index, tail) = match rest.find('/') {
                Some(at) => (&rest[..at], &rest[at..]),
                None => (rest, ""),
            };
            let index: usize = match index.parse() {
                Ok(index) => index,
                Err(_) => continue,
            };
            let entry = match checked.get(index) {
                Some(entry) => entry,
                None => continue,
            };
            let real = SchemaFailure {
                pointer: format!("{}{tail}", entry.pointer),
                kind: failure.kind.clone(),
            };
            found.push(to_diagnostic(&real, document, file, schema, Some(entry)));
        }
    }

    Ok(found)
}

/// The one finding a file that will not parse produces.
pub fn unparseable(file: &str, message: &str, position: Position) -> Diagnostic {
    Diagnostic::error(
        "E100",
        file,
        position,
        format!("The file is not valid YAML: {message}"),
    )
}

/// The one finding a file that parses but is not a suite produces.
pub fn not_a_mapping(file: &str) -> Diagnostic {
    Diagnostic::error(
        "E100",
        file,
        Position::start(),
        "The file does not hold a YAML mapping, so it cannot be a suite.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pointer_reads_as_a_place() {
        assert_eq!(pointer_name(""), "the suite");
        assert_eq!(pointer_name("/tests/0"), "the suite at /tests/0");
    }

    #[test]
    fn a_shape_matches_any_index() {
        assert!(is_shaped("/tests/0", &["tests", "#"]));
        assert!(is_shaped("/tests/12", &["tests", "#"]));
        assert!(!is_shaped("/tests/0/steps", &["tests", "#"]));
        assert!(!is_shaped("/tests/name", &["tests", "#"]));
        assert!(!is_shaped("/metaSteps/0", &["tests", "#"]));
        assert!(is_shaped("/tests/0/asserts/1", &["tests", "#", "asserts", "#"]));
        assert!(!is_shaped("", &["tests", "#"]));
    }

    #[test]
    fn the_two_findings_a_file_that_will_not_parse_gets() {
        let broken = unparseable("a.yml", "it stopped", Position::new(3, 2));
        assert_eq!(broken.code, "E100");
        assert_eq!(broken.position, Position::new(3, 2));
        assert!(broken.message.contains("it stopped"));
        let listy = not_a_mapping("a.yml");
        assert_eq!(listy.code, "E100");
        assert_eq!(listy.position, Position::start());
    }
}
