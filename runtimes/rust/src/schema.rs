//! The vocabulary every runtime shares: the generated schema and the action
//! catalog, read from files at run time.
//!
//! Nothing here is compiled in. `suite.schema.json` and `actions.catalog.yaml`
//! are the same two files the other runtimes read and the spec's
//! `Build-Schema.ps1` writes, so a runtime cannot hold an opinion about the
//! format that the others do not share.
//!
//! A catalog may import other catalogs (DEC-S10): `imports` lists them,
//! relative to the importing file, and they are read depth first in listed
//! order before the catalog's own actions. A name declared twice is an error
//! naming both files; an import cycle is an error.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::model;

/// One action as the catalog declares it.
#[derive(Debug, Clone)]
pub struct Action {
    pub name: String,
    pub bindings: Vec<String>,
    pub interruptible: bool,
    pub deprecated: bool,
    pub params: Vec<String>,
    /// The shape of what the action captures, or nothing when the catalog
    /// leaves it open. Only a closed shape can be checked, which is what keeps
    /// `E302` honest about an API response nobody has declared.
    pub captures: Option<Value>,
}

/// Everything read from the schema directory.
#[derive(Debug, Clone)]
pub struct Schema {
    /// The generated schema with its conditional step union swapped for the
    /// envelope. Steps are checked one branch at a time afterwards, because a
    /// validator that reports every unselected branch reports four problems
    /// where there is one.
    pub document: Value,
    pub defs: Value,
    pub actions: BTreeMap<String, Action>,
    pub action_names: Vec<String>,
    pub assert_operators: Vec<String>,
    pub step_common_keys: Vec<String>,
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

fn property_names(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Object(map)) => map.keys().cloned().collect(),
        _ => Vec::new(),
    }
}

/// Read `suite.schema.json` and `actions.catalog.yaml` from one directory.
pub fn load(schema_root: &Path) -> Result<Schema, String> {
    let schema_path = schema_root.join("suite.schema.json");
    let catalog_path = schema_root.join("actions.catalog.yaml");
    for path in [&schema_path, &catalog_path] {
        if !path.is_file() {
            return Err(format!(
                "Suite schema not found at {}. Generate it with the spec's Build-Schema.ps1 -Catalog <catalog>.",
                path.display()
            ));
        }
    }

    let schema_text = std::fs::read_to_string(&schema_path)
        .map_err(|failure| format!("{} cannot be read: {failure}", schema_path.display()))?;
    let mut document: Value = serde_json::from_str(&schema_text)
        .map_err(|failure| format!("{} is not JSON: {failure}", schema_path.display()))?;

    let envelope = document
        .get("$defs")
        .and_then(|defs| defs.get("stepEnvelope"))
        .cloned()
        .ok_or_else(|| "suite.schema.json carries no stepEnvelope definition.".to_string())?;
    let assert_operators: Vec<String> = property_names(
        document
            .get("$defs")
            .and_then(|defs| defs.get("assert"))
            .and_then(|assert| assert.get("properties")),
    )
    .into_iter()
    .filter(|name| name != "var")
    .collect();
    let step_common_keys = property_names(
        document
            .get("$defs")
            .and_then(|defs| defs.get("stepCommon"))
            .and_then(|common| common.get("properties")),
    );
    if let Some(defs) = document.get_mut("$defs").and_then(Value::as_object_mut) {
        defs.insert("step".to_string(), envelope);
    }
    let defs = document.get("$defs").cloned().unwrap_or(Value::Null);

    let mut entries: Vec<(Value, PathBuf)> = Vec::new();
    catalog_entries(&catalog_path, &mut Vec::new(), &mut entries)?;

    let mut actions: BTreeMap<String, Action> = BTreeMap::new();
    let mut declared_in: BTreeMap<String, PathBuf> = BTreeMap::new();
    {
        for (entry, file) in &entries {
            let name = match entry.get("name").and_then(Value::as_str) {
                Some(name) => name.to_string(),
                None => continue,
            };
            if let Some(first) = declared_in.get(&name) {
                return Err(format!(
                    "Action {name} is declared twice: in {} and in {}.",
                    first.display(),
                    file.display()
                ));
            }
            declared_in.insert(name.clone(), file.clone());
            let params = entry
                .get("params")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|param| param.get("name").and_then(Value::as_str))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            actions.insert(
                name.clone(),
                Action {
                    name,
                    bindings: string_list(entry.get("bindings")),
                    interruptible: entry
                        .get("interruptible")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    deprecated: entry
                        .get("deprecated")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    params,
                    captures: entry.get("captures").cloned(),
                },
            );
        }
    }
    let action_names: Vec<String> = actions.keys().cloned().collect();

    Ok(Schema {
        document,
        defs,
        actions,
        action_names,
        assert_operators,
        step_common_keys,
    })
}

/// Every action entry of a catalog and of the catalogs it imports, each with
/// the file that declares it: imports first, depth first in listed order, each
/// relative to the file that names it; then the catalog's own.
fn catalog_entries(file: &Path, visiting: &mut Vec<PathBuf>, out: &mut Vec<(Value, PathBuf)>) -> Result<(), String> {
    let key = absolute(file);
    if visiting.contains(&key) {
        let chain: Vec<String> = visiting
            .iter()
            .chain(std::iter::once(&key))
            .map(|step| step.display().to_string())
            .collect();
        return Err(format!("Catalog import cycle: {}", chain.join(" -> ")));
    }
    let text = std::fs::read_to_string(&key)
        .map_err(|failure| format!("{} cannot be read: {failure}", key.display()))?;
    let catalog = model::load(&text)
        .map_err(|failure| format!("{} is not YAML: {}", key.display(), failure.message))?;
    visiting.push(key.clone());
    let directory = key.parent().map(Path::to_path_buf).unwrap_or_default();
    for raw in string_list(catalog.value.get("imports")) {
        let imported = directory.join(&raw);
        if !imported.is_file() {
            return Err(format!(
                "{} imports {raw}, which does not exist ({}).",
                key.display(),
                absolute(&imported).display()
            ));
        }
        catalog_entries(&imported, visiting, out)?;
    }
    visiting.pop();
    if let Some(declared) = catalog.value.get("actions").and_then(Value::as_array) {
        for entry in declared {
            if entry.is_object() {
                out.push((entry.clone(), key.clone()));
            }
        }
    }
    Ok(())
}

/// A path made absolute and free of `.` and `..`, without touching the disk,
/// so one file reached two ways is one key.
fn absolute(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut clean = PathBuf::new();
    for part in joined.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                clean.pop();
            }
            other => clean.push(other.as_os_str()),
        }
    }
    clean
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus_schema() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/schema")
    }

    fn committed() -> Schema {
        load(&corpus_schema()).unwrap()
    }

    /// A scratch schema folder holding the corpus's suite.schema.json and the
    /// given catalogs, by file name.
    fn scratch(name: &str, catalogs: &[(&str, &str)]) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("suiterun-schema-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::copy(corpus_schema().join("suite.schema.json"), folder.join("suite.schema.json")).unwrap();
        for (file, text) in catalogs {
            std::fs::write(folder.join(file), text).unwrap();
        }
        folder
    }

    #[test]
    fn the_catalog_declares_the_actions_the_suites_call() {
        let schema = committed();
        // core.noop and wait come from the imported core catalog, fixture.state from the corpus's own.
        assert!(schema.actions.contains_key("core.noop"));
        assert!(schema.actions.contains_key("wait"));
        assert!(schema.actions.contains_key("fixture.state"));
        assert!(schema.action_names.len() >= 12, "{}", schema.action_names.len());
        let mut sorted = schema.action_names.clone();
        sorted.sort();
        assert_eq!(schema.action_names, sorted, "the names come out in one order");
    }

    #[test]
    fn an_action_carries_what_the_catalog_says_about_it() {
        let schema = committed();
        let invoke = &schema.actions["invoke"];
        assert_eq!(invoke.bindings, vec!["powershell".to_string()]);
        assert!(!invoke.interruptible);
        assert!(!invoke.deprecated);
        assert!(invoke.params.contains(&"script".to_string()));
        let noop = &schema.actions["core.noop"];
        assert!(noop.bindings.contains(&"rust".to_string()));
        assert!(noop.interruptible);
    }

    #[test]
    fn the_step_union_is_swapped_for_the_envelope() {
        let schema = committed();
        let step = &schema.defs["step"];
        let envelope = &schema.defs["stepEnvelope"];
        assert_eq!(step, envelope);
        assert_eq!(&schema.document["$defs"]["step"], envelope);
    }

    #[test]
    fn the_operator_and_common_key_lists_come_from_the_schema() {
        let schema = committed();
        assert!(schema.assert_operators.contains(&"equals".to_string()));
        assert!(schema.assert_operators.contains(&"isNotNull".to_string()));
        assert!(!schema.assert_operators.contains(&"var".to_string()));
        assert!(schema.step_common_keys.contains(&"captureAs".to_string()));
        assert!(schema.step_common_keys.contains(&"timeoutSec".to_string()));
    }

    #[test]
    fn a_missing_schema_says_which_file_and_what_to_run() {
        let refused = load(Path::new("nowhere-at-all")).unwrap_err();
        assert!(refused.contains("Build-Schema.ps1"), "{refused}");
    }

    const ONE: &str = "catalogVersion: 1\nactions:\n  - { name: one.a, bindings: [rust] }\n";

    #[test]
    fn imports_are_read_depth_first_relative_to_the_importing_file() {
        let folder = scratch("imports", &[]);
        std::fs::create_dir_all(folder.join("lib")).unwrap();
        std::fs::write(folder.join("lib").join("one.yaml"), ONE).unwrap();
        std::fs::write(
            folder.join("lib").join("two.yaml"),
            "imports: [one.yaml]\nactions:\n  - { name: two.b, bindings: [rust] }\n",
        )
        .unwrap();
        std::fs::write(
            folder.join("actions.catalog.yaml"),
            "imports: [lib/two.yaml]\nactions:\n  - { name: own.c, bindings: [rust], interruptible: false }\n",
        )
        .unwrap();
        let schema = load(&folder).unwrap();
        assert_eq!(schema.action_names, vec!["one.a", "own.c", "two.b"]);
        assert!(!schema.actions["own.c"].interruptible);
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn a_name_declared_twice_names_both_files() {
        let folder = scratch("twice", &[("one.yaml", ONE)]);
        std::fs::write(
            folder.join("actions.catalog.yaml"),
            "imports: [one.yaml]\nactions:\n  - { name: one.a, bindings: [rust] }\n",
        )
        .unwrap();
        let refused = load(&folder).unwrap_err();
        assert!(refused.contains("Action one.a is declared twice"), "{refused}");
        assert!(refused.contains("one.yaml") && refused.contains("actions.catalog.yaml"), "{refused}");
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn an_import_cycle_is_refused() {
        let folder = scratch("cycle", &[("a.yaml", "imports: [b.yaml]\n"), ("b.yaml", "imports: [a.yaml]\n")]);
        std::fs::write(folder.join("actions.catalog.yaml"), "imports: [a.yaml]\n").unwrap();
        let refused = load(&folder).unwrap_err();
        assert!(refused.contains("Catalog import cycle"), "{refused}");
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn a_missing_import_is_refused_by_name() {
        let folder = scratch("missing", &[]);
        std::fs::write(folder.join("actions.catalog.yaml"), "imports: [nowhere.yaml]\n").unwrap();
        let refused = load(&folder).unwrap_err();
        assert!(refused.contains("imports nowhere.yaml, which does not exist"), "{refused}");
        let _ = std::fs::remove_dir_all(&folder);
    }
}


/// The same schema with a corpus catalog overlay merged into it.
///
/// An overlay exists so a rule the catalog drives - a deprecated action, a
/// parameter the shipped catalog does not declare - can be proved without
/// changing the catalog every binding reads. Merge by action name: each key
/// given replaces the key in the shipped catalog, and a params entry replaces
/// the one with the same name or is appended when there is none.
///
/// The generated step branch is patched alongside the catalog, because the
/// structural pass checks a step against `#/$defs/step.<action>` and the
/// catalog is what that branch was generated from. Regenerating it in full
/// would mean running the generator, which is a PowerShell script; adding the
/// parameter the overlay declares is the part of that generation an overlay
/// can change.
pub fn with_overlay(base: &Schema, overlay: &Value) -> Result<Schema, String> {
    let mut schema = base.clone();
    let actions = match overlay.get("actions").and_then(Value::as_array) {
        Some(actions) => actions,
        None => return Ok(schema),
    };
    for patch in actions {
        let name = match patch.get("name").and_then(Value::as_str) {
            Some(name) => name.to_string(),
            None => continue,
        };
        let action = schema
            .actions
            .get_mut(&name)
            .ok_or_else(|| format!("The overlay patches {name}, which the catalog does not declare."))?;
        if let Some(deprecated) = patch.get("deprecated").and_then(Value::as_bool) {
            action.deprecated = deprecated;
        }
        if let Some(bindings) = patch.get("bindings") {
            action.bindings = string_list(Some(bindings));
        }
        if let Some(interruptible) = patch.get("interruptible").and_then(Value::as_bool) {
            action.interruptible = interruptible;
        }
        let added: Vec<(String, Value)> = patch
            .get("params")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|param| {
                        param
                            .get("name")
                            .and_then(Value::as_str)
                            .map(|found| (found.to_string(), param.clone()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        for (param_name, declaration) in added {
            if !action.params.contains(&param_name) {
                action.params.push(param_name.clone());
            }
            let branch = format!("step.{name}");
            if let Some(properties) = schema
                .defs
                .get_mut(&branch)
                .and_then(|found| found.get_mut("properties"))
                .and_then(Value::as_object_mut)
            {
                let mut shape = serde_json::Map::new();
                if let Some(kind) = declaration.get("type") {
                    shape.insert("type".to_string(), kind.clone());
                }
                if let Some(description) = declaration.get("description") {
                    shape.insert("description".to_string(), description.clone());
                }
                properties.insert(param_name, Value::Object(shape));
            }
        }
    }
    // The document carries its own copy of the definitions, and the structural
    // pass reads that one.
    if let Some(defs) = schema.document.get_mut("$defs") {
        *defs = schema.defs.clone();
    }
    Ok(schema)
}
