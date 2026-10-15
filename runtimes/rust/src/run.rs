//! The four verbs, and the exit code each of them leaves.
//!
//! Kept in the library rather than in `main.rs` so that the conformance tests
//! drive exactly what the command line drives. A test that exercised a
//! different path would prove the wrong thing.
//!
//! Every verb takes the run's [`Registry`]: the core and its extensions.
//! [`execute`] is the core alone; [`execute_with`] is what a consumer's own
//! `suiterun` calls.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::cli::{Options, ReportFormat, Verb};
use crate::extension::Registry;
use crate::trace::Trace;
use crate::{diag, exec, exit, model, paths, schema, suite, validate};

/// What a verb produced: what to print, and the code to exit with.
pub struct Report {
    pub out: String,
    pub errors: String,
    pub code: i32,
}

impl Report {
    fn refused(message: impl Into<String>) -> Self {
        Report {
            out: String::new(),
            errors: message.into(),
            code: exit::REFUSED,
        }
    }
}

/// The workspace root (found from the working directory) and the schema root.
/// With `--schema-root` no walk is needed: findings are then relative to the
/// workspace root when there is one, else to the working directory.
fn roots(options: &Options) -> Result<(PathBuf, PathBuf), String> {
    let working = std::env::current_dir().map_err(|failure| failure.to_string())?;
    roots_from(options, &working)
}

fn roots_from(options: &Options, working: &Path) -> Result<(PathBuf, PathBuf), String> {
    let root = paths::repository_root(working);
    if let Some(given) = &options.schema_root {
        return Ok((root.unwrap_or_else(|| working.to_path_buf()), working.join(given)));
    }
    match root {
        Some(root) => {
            let schema_root = paths::schema_root(&root);
            Ok((root, schema_root))
        }
        None => Err(
            "the workspace root cannot be found from this directory (no test/e2e/schema above it); pass --schema-root."
                .to_string(),
        ),
    }
}

fn selected_files(options: &Options) -> Result<Vec<PathBuf>, String> {
    let working = std::env::current_dir().map_err(|failure| failure.to_string())?;
    paths::resolve(&options.path, &working)
}

/// `lint`: validate every selected suite and run nothing.
pub fn lint(options: &Options, registry: &Registry) -> Report {
    let (repository, schema_root) = match roots(options) {
        Ok(found) => found,
        Err(failure) => return Report::refused(failure),
    };
    let schema = match schema::load(&schema_root) {
        Ok(schema) => schema,
        Err(failure) => return Report::refused(failure),
    };
    let files = match selected_files(options) {
        Ok(files) => files,
        Err(failure) => return Report::refused(failure),
    };

    let mut found = Vec::new();
    for path in &files {
        let relative = diag::relative_path(path, &repository);
        let settings = validate::Options {
            binding: options.binding.clone(),
            binding_check: options.binding_check,
            params: options.params.clone(),
            extensions: registry.clone(),
        };
        match validate::file(path, &relative, &schema, &settings) {
            Ok(findings) => found.extend(findings),
            Err(failure) => return Report::refused(failure),
        }
    }
    found = diag::sorted(found);

    let out = if options.json {
        serde_json::to_string_pretty(&diag::to_json_array(&found)).unwrap_or_default()
    } else {
        let mut lines: Vec<String> = found.iter().map(|finding| finding.to_human()).collect();
        lines.push(format!(
            "Lint {}: {} suite file(s), {} finding(s).",
            if diag::fails(&found, options.strict) { "failed" } else { "clean" },
            files.len(),
            found.len()
        ));
        lines.join("\n")
    };
    Report {
        out,
        errors: String::new(),
        code: if diag::fails(&found, options.strict) {
            exit::REFUSED
        } else {
            exit::PASSED
        },
    }
}

/// `list`: the cases a run would select, and nothing else.
pub fn list(options: &Options) -> Report {
    let files = match selected_files(options) {
        Ok(files) => files,
        Err(failure) => return Report::refused(failure),
    };
    let mut lines = Vec::new();
    for path in &files {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(failure) => return Report::refused(format!("{} cannot be read: {failure}", path.display())),
        };
        let model = match model::load(&text) {
            Ok(document) => document.value,
            Err(failure) => return Report::refused(format!("{} is not valid YAML: {}", path.display(), failure.message)),
        };
        for case in suite::cases(&model) {
            let tags = suite::case_tags(&model, &case);
            if !suite::tags_match(&tags, &options.tags) {
                continue;
            }
            lines.push(format!(
                "{}  {}",
                path.file_name().unwrap_or_default().to_string_lossy(),
                suite::text_of(&case, "name")
            ));
        }
    }
    Report {
        out: lines.join("\n"),
        errors: String::new(),
        code: exit::PASSED,
    }
}

/// `actions`: what this runtime registers - the core actions, `wait` and every
/// extension's - which is what a portability check is answered from.
pub fn actions_verb(options: &Options, registry: &Registry) -> Report {
    let names = registry.names();
    let out = if options.json {
        serde_json::to_string_pretty(&Value::Array(
            names.iter().map(|name| Value::String(name.clone())).collect(),
        ))
        .unwrap_or_default()
    } else {
        names.join("\n")
    };
    Report {
        out,
        errors: String::new(),
        code: exit::PASSED,
    }
}

/// `run`: execute every selected case.
pub fn run(options: &Options, registry: &Registry) -> Report {
    let (_, schema_root) = match roots(options) {
        Ok(found) => found,
        Err(failure) => return Report::refused(failure),
    };
    let schema = match schema::load(&schema_root) {
        Ok(schema) => schema,
        Err(failure) => return Report::refused(failure),
    };
    let files = match selected_files(options) {
        Ok(files) => files,
        Err(failure) => return Report::refused(failure),
    };

    let mut trace = Trace::default();
    let mut suites = Vec::new();
    let mut lines = Vec::new();
    // Once per run, shared by every file, so an extension's state persists
    // across files.
    let extensions = exec::RunExtensions::new(registry, &options.extension_options);
    for path in &files {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(failure) => return Report::refused(format!("{} cannot be read: {failure}", path.display())),
        };
        let model = match model::load(&text) {
            Ok(document) => document.value,
            Err(failure) => return Report::refused(format!("{} is not valid YAML: {}", path.display(), failure.message)),
        };
        let settings = exec::Options {
            tags: options.tags.clone(),
            params: options.params.clone(),
            dry_run: options.dry_run,
            record_path: std::env::var(format!("{}RECORD_PATH", registry.env_prefix()))
                .ok()
                .filter(|path| !path.is_empty()),
        };
        match exec::run_file(path, &model, &schema, &settings, &mut trace, &extensions) {
            Ok(result) => {
                lines.push(format!(
                    "=== Suite: {} ===",
                    path.file_name().unwrap_or_default().to_string_lossy()
                ));
                for case in &result.cases {
                    lines.push(format!("  [{:<5}] {}", case.status.as_str(), case.name));
                }
                suites.push(result);
            }
            Err(failure) => return Report::refused(failure),
        }
    }

    let result = exec::RunResult {
        any_failures: false,
        trace,
        suites,
    };
    let failed = exec::failed(&result);

    if let Some(path) = &options.trace_file {
        if let Some(parent) = std::path::Path::new(path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let text = serde_json::to_string_pretty(&result.trace.to_json()).unwrap_or_default();
        if let Err(failure) = std::fs::write(path, text + "\n") {
            return Report::refused(format!("{path} cannot be written: {failure}"));
        }
        lines.push(format!("Trace written to {path}"));
    }
    if let Some(path) = &options.results {
        // Every text a report carries passes through the extensions' redaction.
        let redacted: Vec<exec::SuiteResult> = result
            .suites
            .iter()
            .map(|suite| exec::SuiteResult {
                name: suite.name.clone(),
                cases: suite
                    .cases
                    .iter()
                    .map(|case| exec::CaseResult {
                        message: extensions.started.redact(&case.message),
                        output: extensions.started.redact(&case.output),
                        ..case.clone()
                    })
                    .collect(),
            })
            .collect();
        let document = match options.format {
            ReportFormat::NUnit3 => crate::report::nunit3(&redacted),
            ReportFormat::JUnit => crate::report::junit(&redacted),
        };
        if let Some(parent) = std::path::Path::new(path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(failure) = std::fs::write(path, document) {
            return Report::refused(format!("{path} cannot be written: {failure}"));
        }
        lines.push(format!("Results written to {path}"));
    }
    lines.push(
        if failed {
            "One or more tests failed.".to_string()
        } else if options.dry_run {
            "Suite validation passed; live tests were not run.".to_string()
        } else {
            "All selected tests passed.".to_string()
        },
    );

    Report {
        out: lines.join("\n"),
        errors: String::new(),
        code: if failed { exit::FAILED } else { exit::PASSED },
    }
}

/// One command line, done, by the core alone.
pub fn execute(options: &Options) -> Report {
    execute_with(options, &Registry::core())
}

/// One command line, done, with the given registry: the core and its extensions.
pub fn execute_with(options: &Options, registry: &Registry) -> Report {
    match options.verb {
        Verb::Lint => lint(options, registry),
        Verb::Run => run(options, registry),
        Verb::List => list(options),
        Verb::Actions => actions_verb(options, registry),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli;

    /// This repository's corpus, two folders up from the crate.
    fn corpus_folder() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance")
    }

    /// One command line, read with the corpus's schema root.
    fn options(line: &str) -> Options {
        let mut options = cli::parse(line.split_whitespace().map(str::to_string)).unwrap();
        options.schema_root = Some(corpus_folder().join("schema").to_string_lossy().to_string());
        options
    }

    fn corpus(relative: &str) -> String {
        corpus_folder().join(relative).to_string_lossy().to_string()
    }

    #[test]
    fn actions_lists_what_this_runtime_registers() {
        let report = actions_verb(&options("actions"), &Registry::core());
        assert_eq!(report.code, exit::PASSED);
        assert!(report.out.contains("core.noop"));
        let json = actions_verb(&options("actions --json"), &Registry::core());
        assert!(json.out.trim_start().starts_with('['));
    }

    #[test]
    fn the_schema_root_is_used_without_a_walk_and_without_it_the_walk_must_succeed() {
        let nowhere = std::env::temp_dir().join(format!("suiterun-roots-{}", std::process::id()));
        std::fs::create_dir_all(&nowhere).unwrap();
        let given = options("actions");
        let (root, schema_root) = roots_from(&given, &nowhere).unwrap();
        assert_eq!(root, nowhere);
        assert!(schema_root.join("suite.schema.json").is_file());
        let mut bare = given.clone();
        bare.schema_root = None;
        assert_eq!(
            roots_from(&bare, &nowhere).unwrap_err(),
            "the workspace root cannot be found from this directory (no test/e2e/schema above it); pass --schema-root."
        );
        let workspace = nowhere.join("ws");
        std::fs::create_dir_all(workspace.join("test").join("e2e").join("schema")).unwrap();
        let (root, schema_root) = roots_from(&bare, &workspace.join("test")).unwrap();
        assert_eq!(root, workspace);
        assert_eq!(schema_root, paths::schema_root(&workspace));
        let _ = std::fs::remove_dir_all(&nowhere);
    }

    #[test]
    fn lint_is_clean_on_a_corpus_suite_that_is() {
        let report = execute(&options(&format!("lint --path {}", corpus("execute/hooks.yml"))));
        assert_eq!(report.code, exit::PASSED, "{}", report.out);
        assert!(report.out.contains("Lint clean"));
    }

    #[test]
    fn lint_refuses_a_file_that_does_not_validate() {
        let report = execute(&options(&format!("lint --path {}", corpus("validate/typos.yml"))));
        assert_eq!(report.code, exit::REFUSED);
        assert!(report.out.contains("E101"));
        let json = execute(&options(&format!("lint --json --path {}", corpus("validate/typos.yml"))));
        assert!(json.out.contains("\"code\": \"E101\""), "{}", json.out);
    }

    #[test]
    fn a_path_that_names_nothing_is_a_harness_error() {
        let report = execute(&options("lint --path nosuchfile.yml"));
        assert_eq!(report.code, exit::REFUSED);
        assert!(report.errors.contains("names no file"));
    }

    #[test]
    fn list_names_the_cases_a_run_would_select() {
        let report = execute(&options(&format!("list --path {}", corpus("execute/tags.yml"))));
        assert_eq!(report.code, exit::PASSED);
        assert!(report.out.contains("the-selected-one"));
        assert!(report.out.contains("the-unselected-one"));
        let filtered = execute(&options(&format!(
            "list --path {} --tags wanted",
            corpus("execute/tags.yml")
        )));
        assert!(filtered.out.contains("the-selected-one"));
        assert!(!filtered.out.contains("the-unselected-one"));
    }

    #[test]
    fn a_run_that_passes_exits_zero_and_one_that_fails_exits_one() {
        let passed = execute(&options(&format!("run --path {}", corpus("execute/hooks.yml"))));
        assert_eq!(passed.code, exit::PASSED, "{}", passed.out);
        let failed = execute(&options(&format!("run --path {}", corpus("execute/gherkin.yml"))));
        assert_eq!(failed.code, exit::FAILED, "{}", failed.out);
        assert!(failed.out.contains("One or more tests failed"));
    }
}
