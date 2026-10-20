//! One suite file as the runner executes it: meta steps expanded, tables and
//! outlines turned into one step per row, parameters resolved, and every step
//! carrying a label a report and a trace can print.
//!
//! Everything here happens before the first action runs. A file that expands
//! cleanly is a file whose shape the run no longer has to think about.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::expr;
use crate::value as values;

/// How deep a meta step may use another before it is a cycle rather than a
/// nest, which is refused here rather than left to recurse.
const META_DEPTH_LIMIT: usize = 5;

const GHERKIN_KEYWORDS: [&str; 4] = ["given", "when", "then", "and"];

pub fn text_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn array_of<'a>(value: &'a Value, key: &str) -> Vec<&'a Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|list| list.iter().collect())
        .unwrap_or_default()
}

fn owned_array(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn set(step: &mut Value, key: &str, value: Value) {
    if let Some(map) = step.as_object_mut() {
        map.insert(key.to_string(), value);
    }
}

/// What a suite's libraries contribute, in the order they were imported.
#[derive(Debug, Default, Clone)]
pub struct Library {
    pub params: Vec<Value>,
    pub vars: Map<String, Value>,
    pub meta_steps: BTreeMap<String, Value>,
    pub defaults: Map<String, Value>,
}

/// Read the libraries a suite imports, depth first and in order.
///
/// What a library imports is in scope before the library's own declarations, so
/// the nearer file wins. A cycle is refused rather than recursed into.
pub fn read_libraries(model: &Value, file_path: &std::path::Path) -> Result<Library, String> {
    fn walk_imports(
        model: &Value,
        file_path: &std::path::Path,
        visited: &mut Vec<std::path::PathBuf>,
        library: &mut Library,
    ) -> Result<(), String> {
        let directory = file_path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .to_path_buf();
        for import in array_of(model, "imports") {
            let name = match import.as_str() {
                Some(name) if !name.is_empty() => name,
                _ => continue,
            };
            let path = directory.join(name);
            let full = path.canonicalize().unwrap_or_else(|_| path.clone());
            if visited.contains(&full) {
                return Err(format!("Import {name} forms a cycle."));
            }
            if !path.is_file() {
                return Err(format!("Import {name} does not exist at {}.", path.display()));
            }
            visited.push(full);
            let text = std::fs::read_to_string(&path)
                .map_err(|failure| format!("Import {name} cannot be read: {failure}"))?;
            let imported = crate::model::load(&text)
                .map_err(|failure| format!("Import {name} is not valid YAML: {}", failure.message))?
                .value;
            walk_imports(&imported, &path, visited, library)?;
            for param in owned_array(&imported, "params") {
                if !param.is_null() {
                    library.params.push(param);
                }
            }
            if let Some(vars) = imported.get("vars").and_then(Value::as_object) {
                for (key, value) in vars {
                    library.vars.insert(key.clone(), value.clone());
                }
            }
            for meta in owned_array(&imported, "metaSteps") {
                if !meta.is_null() {
                    library.meta_steps.insert(text_of(&meta, "name"), meta);
                }
            }
            if let Some(defaults) = imported.get("defaults").and_then(Value::as_object) {
                for (key, value) in defaults {
                    library.defaults.insert(key.clone(), value.clone());
                }
            }
        }
        Ok(())
    }

    let mut library = Library::default();
    let mut visited = vec![file_path
        .canonicalize()
        .unwrap_or_else(|_| file_path.to_path_buf())];
    walk_imports(model, file_path, &mut visited, &mut library)?;
    Ok(library)
}

/// Every meta step in scope, indexed by name. A local declaration wins.
pub fn meta_definitions(model: &Value, library: &Library) -> BTreeMap<String, Value> {
    let mut definitions = library.meta_steps.clone();
    for meta in array_of(model, "metaSteps") {
        if !meta.is_null() {
            definitions.insert(text_of(meta, "name"), meta.clone());
        }
    }
    definitions
}

/// Substitute `${param.x}` inside a meta step's body, leaving a name the use
/// site has no value for alone: the dataflow pass is what reports it, with a
/// position.
fn bind_meta_params(value: &Value, arguments: &Map<String, Value>) -> Value {
    match value {
        Value::String(text) => {
            let mut out = text.clone();
            for (name, argument) in arguments {
                out = out.replace(&format!("${{param.{name}}}"), &values::to_text(argument));
            }
            Value::String(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(|item| bind_meta_params(item, arguments)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), bind_meta_params(item, arguments)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// One row as the text a report entry carries: column=value, in order.
pub fn format_row(row: &Value) -> String {
    row.as_object()
        .map(|map| {
            map.iter()
                .map(|(column, value)| format!("{column}={}", values::to_text(value)))
                .collect::<Vec<String>>()
                .join(", ")
        })
        .unwrap_or_default()
}

/// What the trace and a failure call one step.
///
/// The sentence first when the step has one, because that is what says what the
/// step means; the action in brackets, because that is what ran; the row last,
/// because the sentence says what the step means and the row says which of them
/// this is.
pub fn step_label(step: &Value) -> String {
    let action = text_of(step, "action");
    let row = match step.get("__rowIndex").and_then(Value::as_i64) {
        Some(index) => format!(
            " row {index} ({})",
            format_row(step.get("__row").unwrap_or(&Value::Null))
        ),
        None => String::new(),
    };
    let keyword = text_of(step, "__keyword");
    let sentence = text_of(step, "__sentence");
    if !keyword.is_empty() && !sentence.is_empty() {
        return format!("{keyword} {sentence} ({action}){row}");
    }
    let provenance = text_of(step, "__provenance");
    if !provenance.is_empty() {
        return format!("{provenance} ({action}){row}");
    }
    format!("step {action}{row}")
}

/// Lift a step's Gherkin keyword and sentence onto it, so nothing after this
/// has to know which of the four keys carried it.
/// DEC-Y22: an `and` becomes the keyword it continues, once, here. The sentence
/// stays the step's own; only the keyword is inherited, because a report that
/// said `and` on its own would not say whether the step establishes something,
/// exercises it or observes it.
fn resolve_keyword(step: &mut Value, previous: &mut String) {
    for keyword in ["given", "when", "then"] {
        if !text_of(step, keyword).is_empty() {
            *previous = keyword.to_string();
        }
    }
    let continued = text_of(step, "and");
    if !continued.is_empty() {
        let keyword = if previous.is_empty() {
            "and".to_string()
        } else {
            previous.clone()
        };
        set(step, "__keyword", Value::String(keyword));
        set(step, "__sentence", Value::String(continued));
        return;
    }
    for keyword in GHERKIN_KEYWORDS {
        let sentence = text_of(step, keyword);
        if !sentence.is_empty() {
            set(step, "__keyword", Value::String(keyword.to_string()));
            set(step, "__sentence", Value::String(sentence));
            return;
        }
    }
}

/// One step list, with every meta use site replaced by the steps it stands for
/// and every table replaced by one step per row.
pub fn expand_steps(
    steps: &[Value],
    definitions: &BTreeMap<String, Value>,
    where_it_is: &str,
    depth: usize,
    provenance: &str,
) -> Result<Vec<Value>, String> {
    let mut expanded: Vec<Value> = Vec::new();
    // The keyword an `and` continues, tracked across this list only: a case's
    // steps are one scenario and its cleanup is not part of it.
    let mut previous = String::new();
    for (index, step) in steps.iter().enumerate() {
        if step.is_null() {
            continue;
        }
        let position = if provenance.is_empty() {
            format!("step {}", index + 1)
        } else {
            format!("{provenance} step {}", index + 1)
        };

        let used = text_of(step, "meta");
        if !used.is_empty() {
            let definition = definitions.get(&used).ok_or_else(|| {
                format!("{where_it_is} {position} uses meta step {used}, which is not declared or imported.")
            })?;
            if depth >= META_DEPTH_LIMIT {
                return Err(format!(
                    "{where_it_is} {position} nests meta steps deeper than {META_DEPTH_LIMIT}, which is the limit. A meta step that uses itself, directly or through another, is a cycle."
                ));
            }
            let mut arguments: Map<String, Value> = Map::new();
            for declared in array_of(definition, "params") {
                if declared.is_null() {
                    continue;
                }
                if let Some(default) = declared.get("default") {
                    if !default.is_null() {
                        arguments.insert(text_of(declared, "name"), default.clone());
                    }
                }
            }
            if let Some(with) = step.get("with").and_then(Value::as_object) {
                for (key, value) in with {
                    arguments.insert(key.clone(), value.clone());
                }
            }
            let body: Vec<Value> = owned_array(definition, "steps")
                .iter()
                .map(|inner| bind_meta_params(inner, &arguments))
                .collect();
            let guard = text_of(step, "ifCapture");
            for mut inner in expand_steps(&body, definitions, where_it_is, depth + 1, &format!("meta {used}"))? {
                // A nested step that carries a guard from the use site inherits
                // it, so `- meta: x` with ifCapture skips the whole group.
                if !guard.is_empty() && text_of(&inner, "ifCapture").is_empty() {
                    set(&mut inner, "ifCapture", Value::String(guard.clone()));
                }
                expanded.push(inner);
            }
            continue;
        }

        let rows = owned_array(step, "table");
        if step.get("table").is_some() && !step["table"].is_null() {
            let count = rows.len();
            for (row_index, row) in rows.iter().enumerate() {
                let mut copy = step.clone();
                if let Some(map) = copy.as_object_mut() {
                    map.remove("table");
                }
                set(&mut copy, "__row", row.clone());
                set(&mut copy, "__rowIndex", Value::Number(((row_index + 1) as i64).into()));
                set(&mut copy, "__rowCount", Value::Number((count as i64).into()));
                set(&mut copy, "__provenance", Value::String(position.clone()));
                resolve_keyword(&mut copy, &mut previous);
                expanded.push(copy);
            }
            continue;
        }

        let mut copy = step.clone();
        set(&mut copy, "__provenance", Value::String(position));
        resolve_keyword(&mut copy, &mut previous);
        expanded.push(copy);
    }
    Ok(expanded)
}

/// One case per row of its `examples` block, named by the row.
pub fn expand_outline(case: &Value) -> Vec<Value> {
    let rows = owned_array(case, "examples");
    if case.get("examples").is_none() || case["examples"].is_null() || rows.is_empty() {
        return vec![case.clone()];
    }
    let name = text_of(case, "name");
    rows.iter()
        .map(|row| {
            let mut copy = case.clone();
            if let Some(map) = copy.as_object_mut() {
                map.remove("examples");
            }
            set(&mut copy, "name", Value::String(format!("{name} [{}]", format_row(row))));
            set(&mut copy, "__row", row.clone());
            copy
        })
        .collect()
}

/// The value each declared parameter takes, highest source first.
///
/// DEC-Y18, in this order: the command line, the environment, the case, the
/// file, the library. Every level is checked so that the answer is the same
/// whichever level happens to hold a value. The environment is
/// `<prefix>PARAM_<NAME>`, `BDD_SUITE_PARAM_<NAME>` unless an extension sets
/// another prefix.
pub fn resolve_params(
    library: &Library,
    model: &Value,
    case: Option<&Value>,
    command_line: &[(String, String)],
    env_prefix: &str,
) -> Map<String, Value> {
    let mut values: Map<String, Value> = Map::new();
    let take = |declared: &Value, values: &mut Map<String, Value>| {
        let name = text_of(declared, "name");
        if name.is_empty() {
            return;
        }
        if let Some(default) = declared.get("default") {
            if !default.is_null() {
                values.insert(name.clone(), default.clone());
            }
        }
        if let Some(value) = declared.get("value") {
            if !value.is_null() {
                values.insert(name, value.clone());
            }
        }
    };
    for declared in &library.params {
        take(declared, &mut values);
    }
    for declared in array_of(model, "params") {
        take(declared, &mut values);
    }
    if let Some(case) = case {
        for declared in array_of(case, "params") {
            take(declared, &mut values);
        }
    }
    let mut names: Vec<String> = values.keys().cloned().collect();
    for declared in library.params.iter().chain(array_of(model, "params").into_iter()) {
        let name = text_of(declared, "name");
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    for name in names {
        if let Ok(found) = std::env::var(format!("{env_prefix}PARAM_{}", name.to_uppercase())) {
            values.insert(name, Value::String(found));
        }
    }
    for (name, value) in command_line {
        values.insert(name.clone(), Value::String(value.clone()));
    }
    values
}

/// The variables a case sees: the library's, the suite's, then its own, each
/// evaluated once against everything already in scope. `roots` are the roots a
/// path may start at: the core's and the extensions' context keys.
pub fn resolve_vars(
    library: &Library,
    model: &Value,
    case: Option<&Value>,
    scope: &mut Value,
    roots: &[String],
) -> Result<(), String> {
    let mut sources: Vec<&Map<String, Value>> = vec![&library.vars];
    if let Some(vars) = model.get("vars").and_then(Value::as_object) {
        sources.push(vars);
    }
    if let Some(vars) = case.and_then(|case| case.get("vars")).and_then(Value::as_object) {
        sources.push(vars);
    }
    for source in sources {
        for (name, value) in source {
            let resolved = {
                let evaluation = expr::Scope::new(scope).with_roots(roots);
                expr::expand(value, &evaluation).map_err(|failure| failure.to_string())?
            };
            if let Some(map) = scope.get_mut("var").and_then(Value::as_object_mut) {
                map.insert(name.clone(), resolved);
            }
        }
    }
    Ok(())
}

/// Whether a case is selected by a tag filter.
pub fn tags_match(case_tags: &[String], filter: &[String]) -> bool {
    filter.is_empty() || case_tags.iter().any(|tag| filter.contains(tag))
}

/// Whether a case name matches any `--name` glob; none matches every case. The
/// same glob a `--path` takes (`*`, `?`, the whole name), so `*apply*` means
/// one thing everywhere.
pub fn name_matches(case_name: &str, patterns: &[String]) -> bool {
    patterns.is_empty() || patterns.iter().any(|pattern| crate::paths::matches_glob(pattern, case_name))
}

/// Every tag that applies to a case: its own and the suite's.
pub fn case_tags(model: &Value, case: &Value) -> Vec<String> {
    let mut tags: Vec<String> = array_of(case, "tags")
        .into_iter()
        .filter_map(|tag| tag.as_str().map(str::to_string))
        .collect();
    tags.extend(
        array_of(model, "tags")
            .into_iter()
            .filter_map(|tag| tag.as_str().map(str::to_string)),
    );
    tags
}

/// Every step list of one case, expanded, in the order the phases run.
pub fn expanded_case(
    case: &Value,
    definitions: &BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Vec<Value>>, String> {
    let mut phases: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for phase in ["setup", "steps", "cleanup"] {
        let steps = owned_array(case, phase);
        phases.insert(
            phase.to_string(),
            expand_steps(&steps, definitions, &format!("case {}", text_of(case, "name")), 0, "")?,
        );
    }
    Ok(phases)
}

/// The suite's own hook lists, expanded.
pub fn expanded_hooks(
    model: &Value,
    definitions: &BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Vec<Value>>, String> {
    let mut hooks: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for hook in ["setup", "beforeEach", "afterEach", "teardown"] {
        let steps = owned_array(model, hook);
        hooks.insert(
            hook.to_string(),
            expand_steps(&steps, definitions, &format!("the suite {hook}"), 0, "")?,
        );
    }
    Ok(hooks)
}

/// Every case a file runs, outlines expanded.
pub fn cases(model: &Value) -> Vec<Value> {
    let mut found = Vec::new();
    for case in array_of(model, "tests") {
        if case.is_null() {
            continue;
        }
        found.extend(expand_outline(case));
    }
    found
}


/// One step's own limit, or what remains of the case, whichever is smaller.
///
/// The innermost number wins and never raises: a step may shorten its share of
/// the case's budget and may never lengthen it (DEC-Y08).
pub fn step_limit(step_limit_sec: i64, remaining_sec: i64) -> i64 {
    if step_limit_sec > 0 {
        return step_limit_sec.min(remaining_sec);
    }
    remaining_sec
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn definitions() -> BTreeMap<String, Value> {
        let mut map = BTreeMap::new();
        map.insert(
            "mark".to_string(),
            json!({
                "name": "mark",
                "params": [{ "name": "label", "default": "unnamed" }],
                "steps": [
                    { "given": "the marker of ${param.label}", "action": "core.record", "marker": "${param.label}-one" },
                    { "given": "the second of ${param.label}", "action": "core.record", "marker": "${param.label}-two", "captureAs": "second" }
                ]
            }),
        );
        map
    }

    #[test]
    fn a_meta_step_becomes_the_steps_it_stands_for() {
        let steps = vec![json!({ "meta": "mark", "with": { "label": "chosen" } })];
        let expanded = expand_steps(&steps, &definitions(), "case c", 0, "").unwrap();
        assert_eq!(expanded.len(), 2);
        assert_eq!(text_of(&expanded[0], "marker"), "chosen-one");
        assert_eq!(text_of(&expanded[1], "marker"), "chosen-two");
        assert_eq!(text_of(&expanded[0], "__provenance"), "meta mark step 1");
        assert_eq!(text_of(&expanded[0], "__keyword"), "given");
        assert!(step_label(&expanded[0]).starts_with("given the marker of chosen (core.record)"));
    }

    #[test]
    fn a_default_is_used_when_the_use_site_passes_nothing() {
        let steps = vec![json!({ "meta": "mark" })];
        let expanded = expand_steps(&steps, &definitions(), "case c", 0, "").unwrap();
        assert_eq!(text_of(&expanded[0], "marker"), "unnamed-one");
    }

    #[test]
    fn a_guard_on_a_use_site_reaches_every_step_it_stands_for() {
        let steps = vec![json!({ "meta": "mark", "ifCapture": "held" })];
        let expanded = expand_steps(&steps, &definitions(), "case c", 0, "").unwrap();
        assert!(expanded.iter().all(|step| text_of(step, "ifCapture") == "held"));
    }

    #[test]
    fn a_meta_step_nobody_declared_is_refused_by_name() {
        let steps = vec![json!({ "meta": "nosuch" })];
        let refused = expand_steps(&steps, &definitions(), "case c", 0, "").unwrap_err();
        assert!(refused.contains("nosuch"), "{refused}");
        assert!(refused.contains("case c step 1"), "{refused}");
    }

    #[test]
    fn a_nest_past_the_limit_is_refused_rather_than_recursed_into() {
        let mut map = BTreeMap::new();
        map.insert("a".to_string(), json!({ "name": "a", "steps": [{ "meta": "a" }] }));
        let refused = expand_steps(&[json!({ "meta": "a" })], &map, "case c", 0, "").unwrap_err();
        assert!(refused.contains("cycle"), "{refused}");
    }

    #[test]
    fn a_table_becomes_one_step_per_row_in_row_order() {
        let steps = vec![json!({
            "when": "each node is recorded",
            "action": "core.record",
            "marker": "${row.node}",
            "table": [{ "node": "N1" }, { "node": "N2" }],
        })];
        let expanded = expand_steps(&steps, &definitions(), "case c", 0, "").unwrap();
        assert_eq!(expanded.len(), 2);
        assert_eq!(expanded[0]["__rowIndex"], 1);
        assert_eq!(expanded[1]["__rowIndex"], 2);
        assert_eq!(expanded[0]["__rowCount"], 2);
        assert!(expanded[0].get("table").is_none());
        assert!(step_label(&expanded[1]).contains("row 2 (node=N2)"));
    }

    #[test]
    fn an_outline_becomes_one_case_per_row_named_by_it() {
        let case = json!({ "name": "c", "examples": [{ "node": "N1" }, { "node": "N2" }], "steps": [] });
        let expanded = expand_outline(&case);
        assert_eq!(expanded.len(), 2);
        assert_eq!(text_of(&expanded[0], "name"), "c [node=N1]");
        assert_eq!(expanded[1]["__row"]["node"], "N2");
        assert!(expanded[0].get("examples").is_none());
        assert_eq!(expand_outline(&json!({ "name": "c" })).len(), 1);
    }

    #[test]
    fn a_parameter_takes_the_value_of_the_highest_level_that_names_it() {
        let library = Library {
            params: vec![json!({ "name": "shared", "default": "library" })],
            ..Library::default()
        };
        let model = json!({ "params": [{ "name": "shared", "default": "file" }, { "name": "fromFile", "default": "file" }] });
        let case = json!({ "params": [{ "name": "shared", "value": "case" }] });
        let values = resolve_params(&library, &model, Some(&case), &[("fromFile".to_string(), "command line".to_string())], "BDD_SUITE_");
        assert_eq!(values["shared"], "case");
        assert_eq!(values["fromFile"], "command line");
    }

    #[test]
    fn a_limit_may_shorten_and_never_lengthen() {
        assert_eq!(step_limit(0, 120), 120);
        assert_eq!(step_limit(30, 120), 30);
        assert_eq!(step_limit(300, 120), 120);
    }

    #[test]
    fn a_tag_filter_selects_by_any_match() {
        assert!(tags_match(&["a".to_string()], &[]));
        assert!(tags_match(&["a".to_string(), "b".to_string()], &["b".to_string()]));
        assert!(!tags_match(&["a".to_string()], &["b".to_string()]));
        let model = json!({ "tags": ["suite"] });
        let case = json!({ "tags": ["own"] });
        assert_eq!(case_tags(&model, &case), vec!["own".to_string(), "suite".to_string()]);

    }

    #[test]
    fn a_step_with_no_sentence_is_named_for_its_action() {
        assert_eq!(step_label(&json!({ "action": "core.noop" })), "step core.noop");
        assert_eq!(
            step_label(&json!({ "action": "core.noop", "__provenance": "step 1" })),
            "step 1 (core.noop)"
        );
        assert_eq!(format_row(&Value::Null), "");
    }
}
