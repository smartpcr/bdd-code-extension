//! `E201` to `E213`: what a schema cannot see.
//!
//! A product's own rules (a tag-based time ceiling, `E214`) are not here: they
//! belong to the product, and a runtime extension adds rules of its own
//! (`crate::extension::Extension::lint`), seeing the imports listed in
//! [`Library::imports`].
//!
//! Duplicate names, limits and their ceilings, meta steps and their cycles,
//! imports and what they shadow, parameters with no value anywhere, the Gherkin
//! keyword order and the table rules. All of it needs the parsed model and the
//! catalog rather than the file, which is why it is its own level (DEC-Y05).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::diag::Diagnostic;
use crate::model::{self, Document};
use crate::schema::Schema;
use crate::spelling;
use crate::walk;

/// Everything a library may declare. Anything else runs, and a library does
/// not run (DEC-Y17).
const LIBRARY_KEYS: [&str; 6] = [
    "params",
    "vars",
    "metaSteps",
    "defaults",
    "description",
    "schemaVersion",
];

/// The ceiling on any limit. An extension may add a stricter rule of its own.
const LIMIT_CEILING_SEC: i64 = 14400;

const GHERKIN_KEYWORDS: [&str; 4] = ["given", "when", "then", "and"];


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

/// What one meta step is, and where it is written.
#[derive(Debug, Clone)]
struct MetaDefinition {
    definition: Value,
    pointer: String,
}

/// What a suite's imports contribute, and what they collide with.
#[derive(Debug, Default, Clone)]
pub struct Library {
    pub params: BTreeMap<String, ParamDeclaration>,
    pub vars: BTreeMap<String, String>,
    pub meta_steps: BTreeMap<String, Value>,
    pub defaults: BTreeMap<String, String>,
    pub collisions: Vec<Collision>,
    pub diagnostics: Vec<Diagnostic>,
    /// Every import the suite names, in reading order, for an extension's
    /// rules to see.
    pub imports: Vec<Import>,
}

/// One import a suite names: as written, where it is written, and the file it
/// resolves to.
#[derive(Debug, Clone)]
pub struct Import {
    pub import: String,
    pub pointer: String,
    pub file: PathBuf,
}

#[derive(Debug, Clone)]
pub struct ParamDeclaration {
    pub has_value: bool,
    pub pointer: String,
}

#[derive(Debug, Clone)]
pub struct Collision {
    pub kind: String,
    pub name: String,
    pub source: String,
    pub pointer: String,
}

/// Read the libraries a suite imports, depth first and in order.
pub fn imports(document: &Document, file: &str, file_path: &Path) -> Library {
    let mut library = Library::default();
    let mut visited: BTreeSet<PathBuf> = BTreeSet::new();
    visited.insert(file_path.canonicalize().unwrap_or_else(|_| file_path.to_path_buf()));
    let directory = file_path.parent().unwrap_or(Path::new(".")).to_path_buf();

    for (index, import) in array_of(&document.value, "imports").into_iter().enumerate() {
        let import = match import.as_str() {
            Some(text) if !text.is_empty() => text,
            _ => continue,
        };
        let pointer = format!("/imports/{index}");
        let position = document.at(&pointer).value;
        let path = directory.join(import);
        let full = path.canonicalize().unwrap_or_else(|_| path.clone());
        if visited.contains(&full) {
            library.diagnostics.push(Diagnostic::error(
                "E207",
                file,
                position,
                format!("Import {import} forms a cycle."),
            ));
            continue;
        }
        if !path.is_file() {
            library.diagnostics.push(Diagnostic::error(
                "E301",
                file,
                position,
                format!("Import {import} does not exist."),
            ));
            continue;
        }
        visited.insert(full.clone());
        library.imports.push(Import {
            import: import.to_string(),
            pointer: pointer.clone(),
            file: full,
        });
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(failure) => {
                library.diagnostics.push(Diagnostic::error(
                    "E100",
                    file,
                    position,
                    format!("Import {import} cannot be read: {failure}"),
                ));
                continue;
            }
        };
        let imported = match model::load(&text) {
            Ok(imported) => imported.value,
            Err(failure) => {
                library.diagnostics.push(Diagnostic::error(
                    "E100",
                    file,
                    position,
                    format!("Import {import} is not valid YAML: {}", failure.message),
                ));
                continue;
            }
        };
        for key in keys_of(Some(&imported)) {
            if !LIBRARY_KEYS.contains(&key.as_str()) {
                library.diagnostics.push(Diagnostic::error(
                    "E211",
                    file,
                    position,
                    format!(
                        "Import {import} declares {key}. A library declares {} and nothing that runs.",
                        LIBRARY_KEYS.join(", ")
                    ),
                ));
            }
        }
        for param in array_of(&imported, "params") {
            if param.is_null() {
                continue;
            }
            library.params.insert(
                text_of(param, "name"),
                ParamDeclaration {
                    has_value: present(param.get("default")) || present(param.get("input")),
                    pointer: pointer.clone(),
                },
            );
        }
        for name in keys_of(imported.get("vars")) {
            library.vars.insert(name, import.to_string());
        }
        for meta in array_of(&imported, "metaSteps") {
            if !meta.is_null() {
                library.meta_steps.insert(text_of(meta, "name"), meta.clone());
            }
        }
        for name in keys_of(imported.get("defaults")) {
            library.defaults.insert(name, import.to_string());
        }
    }

    // A local declaration that reuses an imported name has to say so.
    for (index, meta) in array_of(&document.value, "metaSteps").into_iter().enumerate() {
        let name = text_of(meta, "name");
        if !meta.is_null() && library.meta_steps.contains_key(&name) && !present(meta.get("override")) {
            library.collisions.push(Collision {
                kind: "Meta step".to_string(),
                name,
                source: "library".to_string(),
                pointer: format!("/metaSteps/{index}/name"),
            });
        }
    }
    for (index, param) in array_of(&document.value, "params").into_iter().enumerate() {
        let name = text_of(param, "name");
        if !param.is_null() && library.params.contains_key(&name) && !present(param.get("override")) {
            library.collisions.push(Collision {
                kind: "Parameter".to_string(),
                name,
                source: "library".to_string(),
                pointer: format!("/params/{index}/name"),
            });
        }
    }
    for name in keys_of(document.value.get("vars")) {
        if let Some(source) = library.vars.get(&name) {
            library.collisions.push(Collision {
                kind: "Variable".to_string(),
                name: name.clone(),
                source: source.clone(),
                pointer: format!("/vars/{}", model::escape(&name)),
            });
        }
    }
    library
}

/// How deep one meta step nests, or the cycle it is part of.
fn meta_depth(
    name: &str,
    definitions: &BTreeMap<String, MetaDefinition>,
    path: &mut Vec<String>,
) -> (usize, Option<Vec<String>>) {
    if path.iter().any(|seen| seen == name) {
        let mut cycle = path.clone();
        cycle.push(name.to_string());
        return (path.len(), Some(cycle));
    }
    let definition = match definitions.get(name) {
        Some(found) => found.clone(),
        None => return (path.len(), None),
    };
    path.push(name.to_string());
    let mut deepest = path.len();
    for step in array_of(&definition.definition, "steps") {
        let used = text_of(step, "meta");
        if used.is_empty() {
            continue;
        }
        let (depth, cycle) = meta_depth(&used, definitions, path);
        if cycle.is_some() {
            path.pop();
            return (depth, cycle);
        }
        deepest = deepest.max(depth);
    }
    path.pop();
    (deepest, None)
}

/// `E204`: an assertion that compares nothing, wherever it is written.
fn assertion_shape(
    assertions: Option<&Value>,
    pointer: &str,
    where_it_is: &str,
    schema: &Schema,
    document: &Document,
    file: &str,
) -> Vec<Diagnostic> {
    let mut found = Vec::new();
    let list = match assertions.and_then(Value::as_array) {
        Some(list) => list,
        None => return found,
    };
    for (index, assertion) in list.iter().enumerate() {
        let map = match assertion.as_object() {
            Some(map) => map,
            None => continue,
        };
        let operators: Vec<&String> = map
            .keys()
            .filter(|key| schema.assert_operators.contains(key))
            .collect();
        let position = document.at(&format!("{pointer}/{index}")).key;
        if operators.is_empty() && present(assertion.get("var")) {
            found.push(
                Diagnostic::error(
                    "E204",
                    file,
                    position,
                    format!(
                        "The assertion on {} in {where_it_is} names a subject and no comparison, so it asserts nothing.",
                        text_of(assertion, "var")
                    ),
                )
                .suggest(format!("One of: {}", schema.assert_operators.join(", "))),
            );
        } else if !present(assertion.get("var")) && !present(assertion.get("script")) {
            found.push(Diagnostic::error(
                "E204",
                file,
                position,
                format!("An assertion in {where_it_is} names no subject. Add var, or use script."),
            ));
        }
    }
    found
}

/// `E213`: a table whose rows do not agree, or repeat.
fn table_rules(
    table: Option<&Value>,
    pointer: &str,
    where_it_is: &str,
    document: &Document,
    file: &str,
) -> Vec<Diagnostic> {
    let mut found = Vec::new();
    let list = match table.and_then(Value::as_array) {
        Some(list) => list,
        None => return found,
    };
    let rows: Vec<&Value> = list.iter().filter(|row| !row.is_null()).collect();
    if rows.is_empty() {
        found.push(Diagnostic::error(
            "E213",
            file,
            document.at(pointer).key,
            format!("The table on {where_it_is} has no rows, so the step it drives would never run."),
        ));
        return found;
    }
    let columns = walk::table_columns(table);
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for (index, row) in list.iter().enumerate() {
        if row.is_null() {
            continue;
        }
        let row_columns = keys_of(Some(row));
        let missing: Vec<String> = columns
            .iter()
            .filter(|column| !row_columns.contains(column))
            .cloned()
            .collect();
        let extra: Vec<String> = row_columns
            .iter()
            .filter(|column| !columns.contains(column))
            .cloned()
            .collect();
        let position = document.at(&format!("{pointer}/{index}")).key;
        if !missing.is_empty() || !extra.is_empty() {
            let mut parts: Vec<String> = missing
                .iter()
                .map(|name| format!("{name} is missing"))
                .collect();
            parts.extend(extra.iter().map(|name| format!("{name} is extra")));
            found.push(Diagnostic::error(
                "E213",
                file,
                position,
                format!(
                    "Row {} of the table on {where_it_is} does not declare the same columns as the first row: {}.",
                    index + 1,
                    parts.join(", ")
                ),
            ));
        }
        let mut sorted = row_columns.clone();
        sorted.sort();
        let signature = sorted
            .iter()
            .map(|column| {
                let value = row.get(column).cloned().unwrap_or(Value::Null);
                format!("{column}={}", crate::value::to_text(&value))
            })
            .collect::<Vec<String>>()
            .join("\u{1}");
        match seen.get(&signature) {
            Some(first) => found.push(Diagnostic::error(
                "E213",
                file,
                position,
                format!(
                    "Row {} of the table on {where_it_is} repeats row {first}, which would give two iterations the same name.",
                    index + 1
                ),
            )),
            None => {
                seen.insert(signature, index + 1);
            }
        }
    }
    found
}

/// `E212`, `E213` and `W304`: the keywords are used in order, and a list is
/// labelled all the way through or not at all.
fn scenario_rules(document: &Document, file: &str) -> Vec<Diagnostic> {
    let mut found = Vec::new();
    let rank = |keyword: &str| match keyword {
        "given" => 1,
        "when" => 2,
        "then" => 3,
        _ => 0,
    };
    for list in walk::step_lists(&document.value) {
        let mut previous: Option<String> = None;
        let mut highest = 0;
        let mut labelled = 0usize;
        let mut total = 0usize;
        for (index, step) in list.steps.iter().enumerate() {
            if !step.is_object() {
                continue;
            }
            let step_pointer = format!("{}/{index}", list.pointer);
            let keys = keys_of(Some(step));
            let found_keywords: Vec<String> = keys
                .iter()
                .filter(|key| GHERKIN_KEYWORDS.contains(&key.as_str()))
                .cloned()
                .collect();
            // A meta use site with no keyword of its own stands for the steps
            // of its definition, and those carry theirs.
            if !found_keywords.is_empty() || !present(step.get("meta")) {
                total += 1;
            }
            if found_keywords.len() > 1 {
                found.push(Diagnostic::error(
                    "E212",
                    file,
                    document.at(&format!("{step_pointer}/{}", found_keywords[1])).key,
                    format!(
                        "Step {} of {} carries {}. A step carries one Gherkin keyword.",
                        index + 1,
                        list.name,
                        found_keywords.join(" and ")
                    ),
                ));
            }
            if let Some(keyword) = found_keywords.first() {
                labelled += 1;
                if keyword == "and" {
                    if previous.is_none() {
                        found.push(
                            Diagnostic::error(
                                "E212",
                                file,
                                document.at(&format!("{step_pointer}/and")).key,
                                format!(
                                    "Step {} of {} is an and with nothing before it to continue.",
                                    index + 1,
                                    list.name
                                ),
                            )
                            .suggest("Start the list with given, when or then."),
                        );
                    }
                } else {
                    if rank(keyword) < highest {
                        let before = match highest {
                            1 => "given",
                            2 => "when",
                            _ => "then",
                        };
                        found.push(
                            Diagnostic::error(
                                "E212",
                                file,
                                document.at(&format!("{step_pointer}/{keyword}")).key,
                                format!(
                                    "Step {} of {} is a {keyword} after a {before}. The order is given, then when, then then.",
                                    index + 1,
                                    list.name
                                ),
                            )
                            .suggest("Continue with and, or move the step."),
                        );
                    }
                    highest = highest.max(rank(keyword));
                    previous = Some(keyword.clone());
                }
            }
            if present(step.get("table")) {
                found.extend(table_rules(
                    step.get("table"),
                    &format!("{step_pointer}/table"),
                    &format!("step {} of {}", index + 1, list.name),
                    document,
                    file,
                ));
                if list
                    .case
                    .as_ref()
                    .is_some_and(|case| present(case.get("examples")))
                {
                    found.push(
                        Diagnostic::error(
                            "E213",
                            file,
                            document.at(&format!("{step_pointer}/table")).key,
                            format!(
                                "Step {} of {} carries a table inside a case that already carries examples. There is one row namespace, and two row scopes would shadow each other.",
                                index + 1,
                                list.name
                            ),
                        )
                        .suggest("Keep the table and drop the examples, or the other way round."),
                    );
                }
            }
        }
        if labelled > 0 && labelled < total {
            found.push(Diagnostic::warning(
                "W304",
                file,
                document.at(&list.pointer).key,
                format!(
                    "{} labels {labelled} of its {total} steps with a Gherkin keyword. Label all of them or none.",
                    list.name
                ),
            ));
        }
    }
    for (index, case) in array_of(&document.value, "tests").into_iter().enumerate() {
        if present(case.get("examples")) {
            found.extend(table_rules(
                case.get("examples"),
                &format!("/tests/{index}/examples"),
                &format!("case {}", text_of(case, "name")),
                document,
                file,
            ));
        }
    }
    found
}

/// `E205`: every declared limit is a positive number under its ceiling. A
/// runtime extension may add a stricter rule of its own.
fn limits(document: &Document, file: &str) -> Vec<Diagnostic> {
    struct Limit {
        pointer: String,
        name: String,
        value: Value,
        scope: String,
    }
    let mut declared: Vec<Limit> = Vec::new();
    for key in [
        "setupTimeoutSec",
        "beforeEachTimeoutSec",
        "afterEachTimeoutSec",
        "teardownTimeoutSec",
    ] {
        if present(document.value.get(key)) {
            declared.push(Limit {
                pointer: format!("/{key}"),
                name: key.to_string(),
                value: document.value[key].clone(),
                scope: "the suite".to_string(),
            });
        }
    }
    for key in ["timeoutSec", "cleanupTimeoutSec"] {
        if let Some(defaults) = document.value.get("defaults") {
            if present(defaults.get(key)) {
                declared.push(Limit {
                    pointer: format!("/defaults/{key}"),
                    name: key.to_string(),
                    value: defaults[key].clone(),
                    scope: "the suite defaults".to_string(),
                });
            }
        }
    }
    for (index, case) in array_of(&document.value, "tests").into_iter().enumerate() {
        for key in ["timeoutSec", "cleanupTimeoutSec", "setupTimeoutSec"] {
            if present(case.get(key)) {
                declared.push(Limit {
                    pointer: format!("/tests/{index}/{key}"),
                    name: key.to_string(),
                    value: case[key].clone(),
                    scope: format!("case {}", text_of(case, "name")),
                });
            }
        }
    }

    let mut found = Vec::new();
    for limit in &declared {
        let ceiling = LIMIT_CEILING_SEC;
        // A limit written as an expression is checked when it is evaluated, and
        // a limit of the wrong type has already been refused by the schema.
        let seconds = match &limit.value {
            Value::Number(number) => match number.as_i64() {
                Some(seconds) => seconds,
                None => continue,
            },
            _ => continue,
        };
        if seconds < 1 || seconds > ceiling {
            found.push(Diagnostic::error(
                "E205",
                file,
                document.at(&limit.pointer).value,
                format!(
                    "{} on {} is {seconds} seconds, outside 1 to {ceiling}.",
                    limit.name, limit.scope
                ),
            ));
        }
    }
    found
}

/// The semantic pass. `env_prefix` names the parameter variables
/// (`<prefix>PARAM_<NAME>`) that count as a value.
#[allow(clippy::too_many_arguments)]
pub fn check(
    document: &Document,
    file: &str,
    schema: &Schema,
    library: &Library,
    binding: &str,
    binding_check: bool,
    command_line_params: &[(String, String)],
    env_prefix: &str,
) -> Vec<Diagnostic> {
    let mut found: Vec<Diagnostic> = Vec::new();
    let model = &document.value;

    // E202: two cases a report cannot tell apart.
    let mut seen_case: BTreeSet<String> = BTreeSet::new();
    for (index, case) in array_of(model, "tests").into_iter().enumerate() {
        if case.is_null() {
            continue;
        }
        let name = text_of(case, "name");
        if !seen_case.insert(name.clone()) {
            found.push(Diagnostic::error(
                "E202",
                file,
                document.at(&format!("/tests/{index}/name")).value,
                format!("Case {name} is declared twice in this suite."),
            ));
        }
    }

    // E203: one case capturing the same name twice.
    for (index, case) in array_of(model, "tests").into_iter().enumerate() {
        if case.is_null() {
            continue;
        }
        let mut seen_capture: BTreeSet<String> = BTreeSet::new();
        for phase in ["setup", "steps", "cleanup"] {
            for entry in walk::step_entries(
                case.get(phase).and_then(Value::as_array),
                &format!("/tests/{index}/{phase}"),
                phase,
            ) {
                let name = text_of(&entry.step, "captureAs");
                if name.is_empty() {
                    continue;
                }
                if !seen_capture.insert(name.clone()) {
                    found.push(Diagnostic::error(
                        "E203",
                        file,
                        document.at(&format!("{}/captureAs", entry.pointer)).value,
                        format!(
                            "Case {} already captures {name}. The second would replace the first.",
                            text_of(case, "name")
                        ),
                    ));
                }
            }
        }
        found.extend(assertion_shape(
            case.get("asserts"),
            &format!("/tests/{index}/asserts"),
            &format!("case {}", text_of(case, "name")),
            schema,
            document,
            file,
        ));
    }
    for entry in walk::all_steps(model) {
        found.extend(assertion_shape(
            entry.step.get("asserts"),
            &format!("{}/asserts", entry.pointer),
            &format!("a {} step", entry.phase),
            schema,
            document,
            file,
        ));
    }

    found.extend(limits(document, file));
    found.extend(scenario_rules(document, file));

    // E206, E207, E208: meta steps exist, do not form a cycle, and are used
    // with the parameters they declare.
    let mut definitions: BTreeMap<String, MetaDefinition> = BTreeMap::new();
    for (index, meta) in array_of(model, "metaSteps").into_iter().enumerate() {
        if !meta.is_null() {
            definitions.insert(
                text_of(meta, "name"),
                MetaDefinition {
                    definition: meta.clone(),
                    pointer: format!("/metaSteps/{index}"),
                },
            );
        }
    }
    for (name, definition) in &library.meta_steps {
        definitions.entry(name.clone()).or_insert(MetaDefinition {
            definition: definition.clone(),
            pointer: String::new(),
        });
    }
    let names: Vec<String> = definitions.keys().cloned().collect();
    for entry in walk::all_steps(model) {
        let used = text_of(&entry.step, "meta");
        if used.is_empty() {
            continue;
        }
        let definition = match definitions.get(&used) {
            Some(definition) => definition.clone(),
            None => {
                let finding = Diagnostic::error(
                    "E206",
                    file,
                    document.at(&format!("{}/meta", entry.pointer)).value,
                    format!("No meta step named {used} is declared or imported."),
                );
                found.push(match spelling::nearest(&used, &names, 2) {
                    Some(nearest) => finding.suggest(nearest),
                    None => finding,
                });
                continue;
            }
        };
        let declared: Vec<String> = array_of(&definition.definition, "params")
            .into_iter()
            .filter(|param| !param.is_null())
            .map(|param| text_of(param, "name"))
            .collect();
        let supplied = keys_of(entry.step.get("with"));
        for param in array_of(&definition.definition, "params") {
            if param.is_null() {
                continue;
            }
            let name = text_of(param, "name");
            let required = param.get("required").and_then(Value::as_bool).unwrap_or(false);
            if required && !supplied.contains(&name) && !present(param.get("default")) {
                found.push(Diagnostic::error(
                    "E208",
                    file,
                    document.at(&format!("{}/meta", entry.pointer)).value,
                    format!("Meta step {used} requires the parameter {name}, and this use site does not pass it."),
                ));
            }
        }
        for name in &supplied {
            if !declared.contains(name) {
                let finding = Diagnostic::error(
                    "E208",
                    file,
                    document
                        .at(&format!("{}/with/{}", entry.pointer, model::escape(name)))
                        .key,
                    format!("Meta step {used} declares no parameter {name}."),
                );
                found.push(match spelling::nearest(name, &declared, 2) {
                    Some(nearest) => finding.suggest(nearest),
                    None => finding,
                });
            }
        }
    }
    for name in &names {
        let mut path: Vec<String> = Vec::new();
        let (depth, cycle) = meta_depth(name, &definitions, &mut path);
        let pointer = &definitions[name].pointer;
        if let Some(cycle) = cycle {
            found.push(Diagnostic::error(
                "E207",
                file,
                document.at(pointer).key,
                format!("Meta step {name} is part of a cycle: {}.", cycle.join(" uses ")),
            ));
        } else if depth > 5 {
            found.push(Diagnostic::error(
                "E207",
                file,
                document.at(pointer).key,
                format!("Meta step {name} nests {depth} deep, and five is the limit."),
            ));
        }
    }

    // E209: a local declaration that silently shadows an imported one.
    for collision in &library.collisions {
        found.push(
            Diagnostic::error(
                "E209",
                file,
                document.at(&collision.pointer).key,
                format!(
                    "{} {} is already declared by the imported {}.",
                    collision.kind, collision.name, collision.source
                ),
            )
            .suggest("Add override: true to say that the replacement is deliberate."),
        );
    }
    found.extend(library.diagnostics.iter().cloned());

    // E210: a parameter with no value anywhere, and a --param nobody declared.
    let mut declared_params: BTreeMap<String, ParamDeclaration> = library.params.clone();
    for (index, param) in array_of(model, "params").into_iter().enumerate() {
        if param.is_null() {
            continue;
        }
        declared_params.insert(
            text_of(param, "name"),
            ParamDeclaration {
                has_value: present(param.get("default")) || present(param.get("value")) || present(param.get("input")),
                pointer: format!("/params/{index}"),
            },
        );
    }
    for (case_index, case) in array_of(model, "tests").into_iter().enumerate() {
        if case.is_null() {
            continue;
        }
        for (param_index, param) in array_of(case, "params").into_iter().enumerate() {
            if param.is_null() {
                continue;
            }
            let name = text_of(param, "name");
            let entry = declared_params.entry(name).or_insert(ParamDeclaration {
                has_value: false,
                pointer: format!("/tests/{case_index}/params/{param_index}"),
            });
            if present(param.get("value")) || present(param.get("default")) || present(param.get("input")) {
                entry.has_value = true;
            }
        }
    }
    let given: BTreeSet<&str> = command_line_params
        .iter()
        .map(|(name, _)| name.as_str())
        .collect();
    for (name, declaration) in &declared_params {
        if declaration.has_value || given.contains(name.as_str()) {
            continue;
        }
        if std::env::var(format!("{env_prefix}PARAM_{}", name.to_uppercase())).is_ok() {
            continue;
        }
        found.push(
            Diagnostic::error(
                "E210",
                file,
                document.at(&declaration.pointer).key,
                format!("Parameter {name} has no value at any level and no default."),
            )
            .suggest(format!("Give it a default, or pass --param {name}=<value>.")),
        );
    }
    let declared_names: Vec<String> = declared_params.keys().cloned().collect();
    for (name, _) in command_line_params {
        if !declared_params.contains_key(name) {
            let finding = Diagnostic::error(
                "E210",
                file,
                document.at("").key,
                format!("--param {name} names a parameter this suite does not declare."),
            );
            found.push(match spelling::nearest(name, &declared_names, 2) {
                Some(nearest) => finding.suggest(nearest),
                None => finding,
            });
        }
    }


    // E201 and W302: the action exists for the binding that was asked for, and
    // is not one the catalog has retired.
    for entry in walk::all_steps(model) {
        let action = text_of(&entry.step, "action");
        let declaration = match schema.actions.get(&action) {
            Some(declaration) => declaration,
            None => continue,
        };
        let position = document.at(&format!("{}/action", entry.pointer)).value;
        if declaration.deprecated {
            found.push(Diagnostic::warning(
                "W302",
                file,
                position,
                format!("Action {action} is marked deprecated in the catalog."),
            ));
        }
        if binding_check && !declaration.bindings.iter().any(|name| name == binding) {
            found.push(Diagnostic::error(
                "E201",
                file,
                position,
                format!(
                    "The {binding} binding does not implement {action}. Implemented by: {}.",
                    declaration.bindings.join(", ")
                ),
            ));
        }
    }

    found
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn a_meta_step_that_uses_itself_is_a_cycle() {
        let mut definitions = BTreeMap::new();
        definitions.insert(
            "a".to_string(),
            MetaDefinition {
                definition: serde_json::json!({ "name": "a", "steps": [{ "meta": "a" }] }),
                pointer: "/metaSteps/0".to_string(),
            },
        );
        let mut path = Vec::new();
        let (_, cycle) = meta_depth("a", &definitions, &mut path);
        assert_eq!(cycle, Some(vec!["a".to_string(), "a".to_string()]));
    }

    #[test]
    fn a_chain_reports_how_deep_it_goes() {
        let mut definitions = BTreeMap::new();
        for level in 1..=3 {
            definitions.insert(
                format!("l{level}"),
                MetaDefinition {
                    definition: serde_json::json!({
                        "name": format!("l{level}"),
                        "steps": [{ "meta": format!("l{}", level + 1) }],
                    }),
                    pointer: format!("/metaSteps/{level}"),
                },
            );
        }
        let mut path = Vec::new();
        let (depth, cycle) = meta_depth("l1", &definitions, &mut path);
        assert_eq!(depth, 3);
        assert!(cycle.is_none());
        let mut path = Vec::new();
        assert_eq!(meta_depth("nosuch", &definitions, &mut path).0, 0);
    }
}
