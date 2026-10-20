//! `suiterun generate` for Rust (spec/test-plan.md): read a test project's
//! `bddsuite.tests.yaml`, build the test plan every runtime builds alike
//! (conformance/generate/), and render the static list of suites and cases a
//! `harness = false` test target includes (`suiterun::testing`, DEC-T11).
//!
//! Generation runs in the test crate's `build.rs`, so the output lands in
//! `$OUT_DIR` and is never committed (DEC-T10); the command line prints the
//! plan (`--plan`), which is what the corpus compares.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::diag::{self, Diagnostic};
use crate::extension::{Extension, Registry};
use crate::suite::{self, text_of};
use crate::{model, schema, validate};

/// The providers a config may name (spec/tests.config.schema.json).
pub const PROVIDERS: [&str; 10] = ["mstest", "nunit", "xunit", "go", "rust", "node", "vitest", "jest", "mocha", "pester"];

const CONFIG_KEYS: [&str; 8] = ["suites", "exclude", "schemaRoot", "provider", "extensions", "offlineActions", "contextKeys", "output"];
const OUTPUT_KEYS: [&str; 3] = ["folder", "namespace", "package"];

/// The case identifiers generated code declares members with, taken before
/// any case of a suite is named (spec/test-plan.md).
pub const RESERVED_IN_SUITE: [&str; 6] = ["Setup", "Teardown", "BeforeEach", "AfterEach", "TestContext", "Session"];

/// One `bddsuite.tests.yaml`, with its paths made absolute against its own
/// folder.
#[derive(Debug, Clone, Default)]
pub struct Config {
    pub file: PathBuf,
    pub suites: Vec<String>,
    pub exclude: Vec<String>,
    pub schema_root: PathBuf,
    pub provider: Option<String>,
    pub extensions: Vec<String>,
    /// `None` when the config has none, which guards nothing.
    pub offline_actions: Option<Vec<String>>,
    pub context_keys: Vec<String>,
    pub output_folder: Option<String>,
    pub namespace: Option<String>,
    pub package: Option<String>,
}

impl Config {
    /// The folder the config's paths are relative to.
    pub fn directory(&self) -> &Path {
        self.file.parent().unwrap_or(Path::new("."))
    }
}

/// A path with `.` and `..` folded away, without touching the file system
/// (which would turn a Windows path into a `\\?\` one).
pub fn clean(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn absolute(path: &Path) -> Result<PathBuf, String> {
    std::path::absolute(path)
        .map(|full| clean(&full))
        .map_err(|failure| format!("{} cannot be made absolute: {failure}", path.display()))
}

fn same_name(left: &std::ffi::OsStr, right: &std::ffi::OsStr) -> bool {
    if cfg!(windows) {
        left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
    } else {
        left == right
    }
}

/// `to` relative to the folder `from`, with forward slashes, or `None` when
/// the two share no root (two Windows drives).
pub fn relative(from: &Path, to: &Path) -> Option<String> {
    let from: Vec<Component> = from.components().collect();
    let to: Vec<Component> = to.components().collect();
    if from.is_empty() || to.is_empty() || !same_name(from[0].as_os_str(), to[0].as_os_str()) {
        return None;
    }
    let mut shared = 0;
    while shared < from.len() && shared < to.len() && same_name(from[shared].as_os_str(), to[shared].as_os_str()) {
        shared += 1;
    }
    let mut parts: Vec<String> = vec!["..".to_string(); from.len() - shared];
    parts.extend(to[shared..].iter().map(|part| part.as_os_str().to_string_lossy().to_string()));
    Some(parts.join("/"))
}

/// Reads one config file, refusing what the schema refuses.
pub fn load_config(path: &Path) -> Result<Config, String> {
    let shown = path.display().to_string();
    let file = absolute(path)?;
    let text = std::fs::read_to_string(&file).map_err(|failure| format!("{shown} cannot be read: {failure}"))?;
    let document = model::load(&text).map_err(|failure| format!("{shown} is not valid YAML: {}", failure.message))?;
    let held = match document.value {
        Value::Object(map) => map,
        _ => return Err(format!("{shown} does not hold a YAML mapping")),
    };
    let refuse = |message: String| format!("{shown}: {message}");
    for key in held.keys() {
        if !CONFIG_KEYS.contains(&key.as_str()) {
            return Err(refuse(format!("{key} is not a config key (spec/tests.config.schema.json).")));
        }
    }
    let texts = |key: &str, required: bool| -> Result<Option<Vec<String>>, String> {
        let Some(raw) = held.get(key) else {
            return if required { Err(refuse(format!("{key} is required."))) } else { Ok(None) };
        };
        let items = raw.as_array().ok_or_else(|| refuse(format!("{key} is a list of non-empty strings.")))?;
        items
            .iter()
            .map(|item| match item.as_str() {
                Some(text) if !text.is_empty() => Ok(text.to_string()),
                _ => Err(refuse(format!("{key} is a list of non-empty strings."))),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some)
    };
    let forward_slashes = |paths: &[String]| -> Result<(), String> {
        match paths.iter().find(|one| one.contains('\\')) {
            Some(one) => Err(refuse(format!("{one} uses a backslash; paths use forward slashes."))),
            None => Ok(()),
        }
    };
    let mut config = Config {
        file,
        ..Config::default()
    };
    config.suites = texts("suites", true)?.unwrap_or_default();
    if config.suites.is_empty() {
        return Err(refuse("suites names no glob.".to_string()));
    }
    config.exclude = texts("exclude", false)?.unwrap_or_default();
    forward_slashes(&config.suites)?;
    forward_slashes(&config.exclude)?;
    let schema_root = held.get("schemaRoot").and_then(Value::as_str).unwrap_or("");
    if schema_root.is_empty() {
        return Err(refuse("schemaRoot is required.".to_string()));
    }
    forward_slashes(&[schema_root.to_string()])?;
    config.schema_root = clean(&config.directory().join(schema_root));
    if let Some(provider) = held.get("provider") {
        let named = provider.as_str().unwrap_or("").to_string();
        if !PROVIDERS.contains(&named.as_str()) {
            return Err(refuse(format!("provider is one of {}, not {named}.", PROVIDERS.join(", "))));
        }
        config.provider = Some(named);
    }
    config.extensions = texts("extensions", false)?.unwrap_or_default();
    if held.contains_key("offlineActions") {
        let patterns = texts("offlineActions", false)?.unwrap_or_default();
        for pattern in &patterns {
            if let Some(star) = pattern.find('*') {
                if !pattern.ends_with(".*") || star != pattern.len() - 1 {
                    return Err(refuse(format!("offlineActions: {pattern} is a name or prefix.*, with no other star.")));
                }
            }
        }
        config.offline_actions = Some(patterns);
    }
    config.context_keys = texts("contextKeys", false)?.unwrap_or_default();
    if let Some(raw) = held.get("output") {
        let output = raw.as_object().ok_or_else(|| refuse("output is a mapping.".to_string()))?;
        for key in output.keys() {
            if !OUTPUT_KEYS.contains(&key.as_str()) {
                return Err(refuse(format!("output.{key} is not an output key.")));
            }
        }
        let text = |key: &str| output.get(key).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_string);
        config.output_folder = text("folder");
        config.namespace = text("namespace");
        config.package = text("package");
    }
    Ok(config)
}

// ------------------------------------------------------------------- globs --

/// The folder a pattern starts in (its segments before the first wildcard)
/// and the rest.
fn split_pattern(root: &Path, pattern: &str) -> (PathBuf, String) {
    let segments: Vec<&str> = pattern.split('/').collect();
    let mut fixed = 0;
    while fixed + 1 < segments.len() && !segments[fixed].contains(['*', '?']) {
        fixed += 1;
    }
    let mut start = root.to_path_buf();
    for segment in &segments[..fixed] {
        start.push(segment);
    }
    (clean(&start), segments[fixed..].join("/"))
}

fn slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn matcher(root: &Path, pattern: &str) -> Regex {
    let (start, rest) = split_pattern(root, pattern);
    let mut built = String::new();
    if cfg!(windows) {
        built.push_str("(?i)");
    }
    built.push('^');
    built.push_str(&regex::escape(slashes(&start).trim_end_matches('/')));
    built.push('/');
    let characters: Vec<char> = rest.chars().collect();
    let mut index = 0;
    while index < characters.len() {
        let one = characters[index];
        if one == '*' && characters.get(index + 1) == Some(&'*') {
            if characters.get(index + 2) == Some(&'/') {
                built.push_str("(?:.*/)?");
                index += 3;
            } else {
                built.push_str(".*");
                index += 2;
            }
            continue;
        }
        match one {
            '*' => built.push_str("[^/]*"),
            '?' => built.push_str("[^/]"),
            other => built.push_str(&regex::escape(&other.to_string())),
        }
        index += 1;
    }
    built.push('$');
    Regex::new(&built).expect("a glob is always a valid expression")
}

fn files_under(folder: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => files_under(&path, found),
            Ok(_) => found.push(path),
            Err(_) => {}
        }
    }
}

/// The files the includes match and the excludes do not, as paths relative
/// to `folder` with forward slashes, in ordinal order (spec/test-plan.md,
/// Building the plan, step 1): `**` any number of folders, `*` any text inside
/// one name, `?` one character, and `..` allowed before the first wildcard.
pub fn select(folder: &Path, includes: &[String], excludes: &[String]) -> Result<Vec<String>, String> {
    let root = absolute(folder)?;
    let rejected: Vec<Regex> = excludes.iter().map(|pattern| matcher(&root, pattern)).collect();
    let mut found = BTreeSet::new();
    for pattern in includes {
        let (start, _) = split_pattern(&root, pattern);
        let accept = matcher(&root, pattern);
        let mut files = Vec::new();
        files_under(&start, &mut files);
        for path in files {
            let full = slashes(&clean(&path));
            if !accept.is_match(&full) || rejected.iter().any(|reject| reject.is_match(&full)) {
                continue;
            }
            if let Some(relative) = relative(&root, &clean(&path)) {
                found.insert(relative);
            }
        }
    }
    Ok(found.into_iter().collect())
}

// ------------------------------------------------------------- identifiers --

/// The identifier a name gives before collisions (spec/test-plan.md,
/// Identifiers): its ASCII letters and digits, each word capitalised, the
/// fallback for a name with none, and `N` before a leading digit.
pub fn identifier_of(name: &str, fallback: &str) -> String {
    let mut built = String::new();
    let mut start_of_word = true;
    for one in name.chars() {
        if !one.is_ascii_alphanumeric() {
            start_of_word = true;
            continue;
        }
        built.push(if start_of_word { one.to_ascii_uppercase() } else { one });
        start_of_word = false;
    }
    if built.is_empty() {
        built = fallback.to_string();
    }
    if built.starts_with(|first: char| first.is_ascii_digit()) {
        built.insert(0, 'N');
    }
    built
}

/// Gives names their identifiers, `_2`, `_3`, ... on a collision compared
/// ignoring ASCII case.
#[derive(Debug, Default)]
pub struct Identifiers {
    taken: BTreeSet<String>,
}

impl Identifiers {
    /// Starts with the given identifiers taken.
    pub fn new(reserved: &[&str]) -> Self {
        Identifiers {
            taken: reserved.iter().map(|one| one.to_ascii_lowercase()).collect(),
        }
    }

    /// The next free identifier for a name.
    pub fn take(&mut self, name: &str, fallback: &str) -> String {
        let wanted = identifier_of(name, fallback);
        let mut candidate = wanted.clone();
        let mut number = 2;
        while self.taken.contains(&candidate.to_ascii_lowercase()) {
            candidate = format!("{wanted}_{number}");
            number += 1;
        }
        self.taken.insert(candidate.to_ascii_lowercase());
        candidate
    }
}

// -------------------------------------------------------------------- plan --

/// One case of a plan: a test the generated code declares.
#[derive(Debug, Clone)]
pub struct PlannedCase {
    pub name: String,
    pub id: String,
    pub tags: Vec<String>,
    /// The outline's own name, for a row of an `examples` table.
    pub outline: Option<String>,
    pub row: Option<Value>,
}

/// One suite of a plan.
#[derive(Debug, Clone)]
pub struct PlannedSuite {
    /// Relative to the config's folder, with forward slashes.
    pub file: String,
    pub full_path: PathBuf,
    pub name: String,
    pub id: String,
    pub tags: Vec<String>,
    pub guarded: bool,
    pub guarded_by: Vec<String>,
    pub cases: Vec<PlannedCase>,
}

/// A config's test plan (spec/test-plan.md).
#[derive(Debug, Clone)]
pub struct Plan {
    pub config: Config,
    pub suites: Vec<PlannedSuite>,
}

/// Whether an `offlineActions` pattern covers an action: the name itself, or
/// `prefix.*` and a name starting with the prefix and its dot.
pub fn covers(pattern: &str, action: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => action.starts_with(prefix),
        None => pattern == action,
    }
}

/// Every action a suite can run: its hooks and every case's phases, meta steps
/// expanded (imported ones too), and the step each `wait` polls.
pub fn actions(model: &Value, path: &Path) -> Result<Vec<String>, String> {
    let library = suite::read_libraries(model, path)?;
    let definitions = suite::meta_definitions(model, &library);
    let mut lists: Vec<Vec<Value>> = suite::expanded_hooks(model, &definitions)?.into_values().collect();
    for case in suite::cases(model) {
        lists.extend(suite::expanded_case(&case, &definitions)?.into_values());
    }
    let mut out = Vec::new();
    for step in lists.iter().flatten() {
        let mut current = Some(step);
        while let Some(held) = current {
            let action = text_of(held, "action");
            if !action.is_empty() {
                out.push(action);
            }
            current = held.get("forStep").filter(|next| next.is_object());
        }
    }
    Ok(out)
}

fn distinct(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    values.into_iter().filter(|one| seen.insert(one.clone())).collect()
}

/// The context keys a config declares, as an extension, so suites lint before
/// any real extension is loaded.
struct ConfigContextKeys(Vec<String>);

impl Extension for ConfigContextKeys {
    fn name(&self) -> &str {
        "the config's context keys"
    }

    fn context_keys(&self) -> Vec<String> {
        self.0.clone()
    }
}

/// Builds a config's plan, or refuses it with the findings of every suite that
/// does not lint clean (`Ok(Err(findings))`): nothing is generated from a
/// partial plan. The outer error is a harness error.
pub fn build(config: &Config) -> Result<Result<Plan, Vec<Diagnostic>>, String> {
    let schema = schema::load(&config.schema_root)?;
    let stand_in: Vec<Arc<dyn Extension>> = vec![Arc::new(ConfigContextKeys(config.context_keys.clone()))];
    let registry = Registry::compose(&stand_in).map_err(|failure| failure.to_string())?;
    let settings = validate::Options {
        binding: "rust".to_string(),
        extensions: registry,
        ..validate::Options::default()
    };
    let mut loaded = Vec::new();
    let mut findings = Vec::new();
    for relative in select(config.directory(), &config.suites, &config.exclude)? {
        let full = clean(&config.directory().join(&relative));
        let text = std::fs::read_to_string(&full).map_err(|failure| format!("{} cannot be read: {failure}", full.display()))?;
        let document = model::load(&text).map_err(|failure| format!("{relative} is not valid YAML: {}", failure.message))?;
        // A library declares and never runs: only a file with a suite key is a
        // suite.
        if document.value.get("suite").is_none() {
            continue;
        }
        findings.extend(validate::file(&full, &relative, &schema, &settings)?);
        loaded.push((relative, full, document.value));
    }
    let findings = diag::sorted(findings);
    if diag::fails(&findings, false) {
        return Ok(Err(findings));
    }

    let mut suites = Vec::new();
    let mut suite_ids = Identifiers::default();
    for (relative, full, held) in loaded {
        let name = text_of(&held, "suite");
        let mut case_ids = Identifiers::new(&RESERVED_IN_SUITE);
        let mut cases = Vec::new();
        for entry in held.get("tests").and_then(Value::as_array).into_iter().flatten() {
            if !entry.is_object() {
                continue;
            }
            let outline = match entry.get("examples").and_then(Value::as_array) {
                Some(rows) if !rows.is_empty() => Some(text_of(entry, "name")),
                _ => None,
            };
            for expanded in suite::expand_outline(entry) {
                let case_name = text_of(&expanded, "name");
                cases.push(PlannedCase {
                    id: case_ids.take(&case_name, "Case"),
                    tags: distinct(suite::case_tags(&held, &expanded)),
                    row: outline.as_ref().and_then(|_| expanded.get("__row").cloned()),
                    outline: outline.clone(),
                    name: case_name,
                });
            }
        }
        let mut guarded_by = Vec::new();
        if let Some(patterns) = &config.offline_actions {
            for action in distinct(actions(&held, &full)?) {
                if !patterns.iter().any(|pattern| covers(pattern, &action)) {
                    guarded_by.push(action);
                }
            }
            guarded_by.sort();
        }
        let tags = held
            .get("tags")
            .and_then(Value::as_array)
            .map(|tags| tags.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        suites.push(PlannedSuite {
            file: relative,
            full_path: full,
            id: suite_ids.take(&name, "Suite"),
            name,
            tags: distinct(tags),
            guarded: !guarded_by.is_empty(),
            guarded_by,
            cases,
        });
    }
    Ok(Ok(Plan {
        config: config.clone(),
        suites,
    }))
}

impl Plan {
    /// The plan as spec/test-plan.schema.json describes it: indented UTF-8 with
    /// non-ASCII characters as themselves.
    pub fn to_json(&self) -> String {
        let suites: Vec<Value> = self
            .suites
            .iter()
            .map(|one| {
                let cases: Vec<Value> = one
                    .cases
                    .iter()
                    .map(|case| {
                        let mut map = Map::new();
                        map.insert("name".into(), json!(case.name));
                        map.insert("id".into(), json!(case.id));
                        if let Some(outline) = &case.outline {
                            map.insert("outline".into(), json!(outline));
                            map.insert("row".into(), case.row.clone().unwrap_or(Value::Null));
                        }
                        map.insert("tags".into(), json!(case.tags));
                        Value::Object(map)
                    })
                    .collect();
                json!({
                    "file": one.file,
                    "name": one.name,
                    "id": one.id,
                    "tags": one.tags,
                    "guarded": one.guarded,
                    "guardedBy": one.guarded_by,
                    "cases": cases,
                })
            })
            .collect();
        serde_json::to_string_pretty(&json!({ "planVersion": 1, "suites": suites })).unwrap_or_default()
    }
}

// --------------------------------------------------------------- Rust code --

/// The first line of every file this generator writes.
pub const GENERATED_PREFIX: &str = "// Code generated by suiterun generate (rust)";

/// A path as Rust source: relative to the crate's manifest folder when `base`
/// is that folder and the path can be reached from it, else absolute.
fn path_literal(path: &Path, base: Option<&Path>) -> String {
    match base.and_then(|base| relative(base, path)) {
        Some(relative) => format!("concat!(env!(\"CARGO_MANIFEST_DIR\"), {:?})", format!("/{relative}")),
        None => format!("{:?}", slashes(path)),
    }
}

/// The Rust a harness target includes: one `suiterun::testing::Suite` per
/// planned suite, with the case names in plan order. `base` is the test
/// crate's manifest folder, which the suite paths are written relative to so
/// the text does not depend on where the repository is checked out.
pub fn render(plans: &[Plan], base: Option<&Path>) -> String {
    let mut out = String::new();
    let configs: Vec<String> = plans
        .iter()
        .map(|plan| base.and_then(|base| relative(base, &plan.config.file)).unwrap_or_else(|| slashes(&plan.config.file)))
        .collect();
    out.push_str(&format!("{GENERATED_PREFIX} from {}. DO NOT EDIT.\n", configs.join(", ")));
    out.push_str("// A harness = false test target passes this to suiterun::testing::main.\n");
    out.push_str("&[\n");
    for plan in plans {
        for one in &plan.suites {
            out.push_str("    suiterun::testing::Suite {\n");
            out.push_str(&format!("        id: {:?},\n", one.id));
            out.push_str(&format!("        name: {:?},\n", one.name));
            out.push_str(&format!("        file: {},\n", path_literal(&one.full_path, base)));
            out.push_str(&format!("        shown: {:?},\n", one.file));
            out.push_str(&format!("        schema_root: {},\n", path_literal(&plan.config.schema_root, base)));
            out.push_str(&format!("        guarded: {},\n", one.guarded));
            out.push_str("        cases: &[\n");
            for case in &one.cases {
                out.push_str(&format!("            {:?},\n", case.name));
            }
            out.push_str("        ],\n");
            out.push_str("    },\n");
        }
    }
    out.push_str("]\n");
    out
}

/// Every folder whose change can change the generated code: the config, each
/// include's starting folder and the schema root. Cargo rescans a folder named
/// by `rerun-if-changed` for any change inside it.
pub fn watched(config: &Config) -> Vec<PathBuf> {
    let mut paths: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut add = |path: PathBuf| {
        paths.insert(slashes(&path), path);
    };
    add(config.file.clone());
    for pattern in &config.suites {
        add(split_pattern(config.directory(), pattern).0);
    }
    add(config.schema_root.clone());
    paths.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance")
    }

    #[test]
    fn an_identifier_is_the_names_words_capitalised() {
        for (name, want) in [
            ("places an order", "PlacesAnOrder"),
            ("rejects a bad quantity [qty=-1]", "RejectsABadQuantityQty1"),
            ("3 retries", "N3Retries"),
            ("!!!", "Case"),
            ("café au lait", "CafAuLait"),
            ("MSTest_v4", "MSTestV4"),
        ] {
            assert_eq!(identifier_of(name, "Case"), want, "{name}");
        }
    }

    #[test]
    fn a_collision_takes_the_first_free_number_ignoring_case() {
        let mut ids = Identifiers::new(&RESERVED_IN_SUITE);
        for (name, want) in [
            ("setup", "Setup_2"),
            ("places an order", "PlacesAnOrder"),
            ("places an order!", "PlacesAnOrder_2"),
            ("PLACES AN ORDER", "PLACESANORDER_3"),
            ("???", "Case"),
            ("...", "Case_2"),
        ] {
            assert_eq!(ids.take(name, "Case"), want, "{name}");
        }
    }

    #[test]
    fn an_offline_pattern_covers_a_name_or_a_prefix() {
        for (pattern, action, covered) in [
            ("core.*", "core.set", true),
            ("core.*", "corelike.set", false),
            ("wait", "wait", true),
            ("wait", "waiting", false),
            ("shop.orders.*", "shop.orders.place", true),
        ] {
            assert_eq!(covers(pattern, action), covered, "{pattern} over {action}");
        }
    }

    #[test]
    fn a_config_the_schema_refuses_is_refused() {
        let folder = std::env::temp_dir().join(format!("suiterun-config-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        for (yaml, says) in [
            ("schemaRoot: s", "suites is required"),
            ("suites: [a.yml]", "schemaRoot is required"),
            ("suites: [a.yml]\nschemaRoot: s\nprovidr: go", "providr is not a config key"),
            ("suites: [a.yml]\nschemaRoot: s\nprovider: junit", "provider is one of"),
            ("suites: ['a\\b.yml']\nschemaRoot: s", "backslash"),
            ("suites: [a.yml]\nschemaRoot: s\nofflineActions: ['core.*.x']", "prefix.*"),
            ("suites: [a.yml]\nschemaRoot: s\noutput: { dir: x }", "output.dir is not an output key"),
        ] {
            let path = folder.join("config.yaml");
            std::fs::write(&path, yaml).unwrap();
            let refused = load_config(&path).unwrap_err();
            assert!(refused.contains(says), "{yaml}: {refused}");
        }
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn a_relative_path_climbs_and_descends() {
        let base = Path::new(env!("CARGO_MANIFEST_DIR"));
        assert_eq!(relative(base, &base.join("a/b.yml")).as_deref(), Some("a/b.yml"));
        assert_eq!(relative(&base.join("x/y"), &base.join("a/b.yml")).as_deref(), Some("../../a/b.yml"));
        assert_eq!(clean(Path::new("a/./b/../c")), PathBuf::from("a/c"));
    }

    #[test]
    fn the_guard_sees_meta_steps_from_libraries_and_polled_steps() {
        let config = load_config(&corpus().join("generate/bddsuite.tests.yaml")).unwrap();
        let plan = build(&config).unwrap().unwrap();
        for one in &plan.suites {
            assert_eq!(one.guarded, one.name == "lab-work", "{}", one.name);
            if one.guarded {
                assert_eq!(one.guarded_by, vec!["fixture.state".to_string(), "inventory.get".to_string()]);
            }
        }
    }

    /// The Rust for the generate corpus equals the committed golden file
    /// (testdata/golden). With BDD_UPDATE_GOLDEN=1 the test writes it instead.
    #[test]
    fn the_rust_code_equals_the_golden_file() {
        let config = load_config(&corpus().join("generate/bddsuite.tests.yaml")).unwrap();
        let plan = build(&config).unwrap().unwrap();
        let text = render(&[plan], Some(Path::new(env!("CARGO_MANIFEST_DIR"))));
        let golden = Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/golden/suites.rs.golden");
        if std::env::var("BDD_UPDATE_GOLDEN").as_deref() == Ok("1") {
            std::fs::create_dir_all(golden.parent().unwrap()).unwrap();
            std::fs::write(&golden, &text).unwrap();
            return;
        }
        let want = std::fs::read_to_string(&golden).expect("no golden file; run with BDD_UPDATE_GOLDEN=1");
        assert_eq!(want.replace("\r\n", "\n"), text, "the generated Rust differs from its golden file");
    }

    #[test]
    fn the_watched_folders_are_the_config_the_include_roots_and_the_schema() {
        let config = load_config(&corpus().join("generate/bddsuite.tests.yaml")).unwrap();
        let watched: Vec<String> = watched(&config).iter().map(|path| slashes(path)).collect();
        assert_eq!(watched.len(), 3, "{watched:?}");
        assert!(watched.iter().any(|path| path.ends_with("generate/bddsuite.tests.yaml")));
        assert!(watched.iter().any(|path| path.ends_with("generate/suites")));
        assert!(watched.iter().any(|path| path.ends_with("conformance/schema")));
    }
}
