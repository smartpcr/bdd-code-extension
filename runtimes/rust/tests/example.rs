//! E3, the Rust part: an extension built outside the crate, on its public API
//! only (this file and the extension compile as an external crate), adds an
//! action, a context key, an option and a rule; the plain runtime has none of
//! them; two extensions cannot define one action.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use suiterun::{Action, Extension};

#[path = "../example/src/extension.rs"]
mod extension;

fn example() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("example")
}

fn schema_root() -> String {
    example().join("schema").to_string_lossy().to_string()
}

fn suite() -> String {
    example().join("suites").join("echo.yml").to_string_lossy().to_string()
}

fn with_echo() -> Vec<Arc<dyn Extension>> {
    vec![Arc::new(extension::Echo)]
}

fn run(arguments: &[&str], extensions: &[Arc<dyn Extension>]) -> (i32, String, String) {
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let arguments: Vec<String> = arguments.iter().map(|argument| argument.to_string()).collect();
    let code = suiterun::main_with(arguments, &mut out, &mut err, extensions);
    (code, String::from_utf8_lossy(&out).to_string(), String::from_utf8_lossy(&err).to_string())
}

fn lint(extensions: &[Arc<dyn Extension>]) -> (i32, Vec<String>) {
    let (schema_root, suite) = (schema_root(), suite());
    let (code, out, err) = run(&["lint", "--schema-root", &schema_root, "--path", &suite, "--json"], extensions);
    let found: Value = serde_json::from_str(&out).unwrap_or_else(|_| panic!("not JSON: {out}{err}"));
    let findings = found
        .as_array()
        .unwrap()
        .iter()
        .map(|row| format!("{} {}:{}", row["code"].as_str().unwrap(), row["line"], row["column"]))
        .collect();
    (code, findings)
}

#[test]
fn with_the_extension_the_action_runs_the_region_reads_the_option_and_the_rule_reports_its_ceiling() {
    let (schema_root, suite) = (schema_root(), suite());
    let (code, out, err) = run(
        &["run", "--schema-root", &schema_root, "--path", &suite, "--region", "eu"],
        &with_echo(),
    );
    assert_eq!(code, 0, "{out}{err}");
    assert!(out.contains("[passed] echoes-with-the-region"), "{out}");
    // Only the rule: timeoutSec 30 in a suite tagged slow.
    assert_eq!(lint(&with_echo()), (2, vec!["E205 5:17".to_string()]));
    let (_, actions, _) = run(&["actions", "--json"], &with_echo());
    let names: Vec<String> = serde_json::from_str(&actions).unwrap();
    assert!(names.contains(&"example.echo".to_string()), "{actions}");
}

#[test]
fn without_it_region_is_e301_no_ceiling_region_is_refused_and_the_action_has_no_handler() {
    let (schema_root, suite) = (schema_root(), suite());
    // The context key is unknown; the slow rule is not there. No E104: the
    // action is in the workspace catalog, and lint follows the catalog.
    assert_eq!(lint(&[]).1, vec!["E301 9:15".to_string()]);
    let (code, _, err) = run(&["run", "--schema-root", &schema_root, "--path", &suite, "--region", "eu"], &[]);
    assert_eq!(code, 2);
    assert!(err.contains("run does not take --region"), "{err}");
    let (code, out, _) = run(&["run", "--schema-root", &schema_root, "--path", &suite], &[]);
    assert_eq!(code, 1, "{out}");
    assert!(out.contains("[failed] echoes-with-the-region"), "{out}");
}

#[test]
fn an_action_no_extension_registers_fails_its_step_saying_so() {
    // The same suite with the region expanded away by a plain registry would
    // fail at ${region} first; call the action directly to see its own message.
    let folder = std::env::temp_dir().join(format!("suiterun-example-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    let suite = folder.join("bare.yml");
    std::fs::write(
        &suite,
        "suite: bare\ntests:\n  - name: calls-the-echo\n    steps:\n      - when: it is called\n        action: example.echo\n        text: hi\n",
    )
    .unwrap();
    let results = folder.join("bare.xml");
    let (schema_root, suite, results) = (
        schema_root(),
        suite.to_string_lossy().to_string(),
        results.to_string_lossy().to_string(),
    );
    let (code, out, _) = run(&["run", "--schema-root", &schema_root, "--path", &suite, "--results", &results], &[]);
    assert_eq!(code, 1, "{out}");
    let report = std::fs::read_to_string(&results).unwrap();
    assert!(
        report.contains("Unknown action: example.echo. No extension of this runtime registers it."),
        "{report}"
    );
    let _ = std::fs::remove_dir_all(&folder);
}

struct Twin;

impl Extension for Twin {
    fn name(&self) -> &str {
        "twin"
    }
    fn actions(&self) -> Vec<Action> {
        vec![Action::new("example.echo", |_| Ok(Value::Null))]
    }
}

#[test]
fn two_extensions_defining_one_action_are_refused_before_anything_runs() {
    let extensions: Vec<Arc<dyn Extension>> = vec![Arc::new(extension::Echo), Arc::new(Twin)];
    let (code, out, err) = run(&["actions"], &extensions);
    assert_eq!((code, out.as_str()), (2, ""));
    assert!(err.contains("Action example.echo is defined by both example and twin"), "{err}");
}

#[test]
fn the_example_is_its_own_program() {
    // A full cargo test builds the examples beside the test binaries
    // (target/<profile>/deps/<test> and target/<profile>/examples/echo); a run
    // of this test alone builds it here, which is quick when it is current.
    let deps = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let profile = deps.parent().unwrap().to_path_buf();
    let mut build = std::process::Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string()));
    build.args(["build", "--quiet", "--example", "echo"]).current_dir(env!("CARGO_MANIFEST_DIR"));
    if profile.file_name().is_some_and(|name| name == "release") {
        build.arg("--release");
    }
    assert!(build.status().unwrap().success(), "the echo example does not build");
    let program = profile.join("examples").join(format!("echo{}", std::env::consts::EXE_SUFFIX));
    assert!(program.is_file(), "{} is not built", program.display());
    let output = std::process::Command::new(&program)
        .args(["run", "--schema-root", &schema_root(), "--path", &suite(), "--region", "eu"])
        .output()
        .unwrap();
    let said = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.status.code(), Some(0), "{said}");
    assert!(said.contains("[passed] echoes-with-the-region"), "{said}");
}

#[test]
fn the_example_uses_only_the_crates_public_api() {
    // It compiles as an external crate, which is what enforces this; the check
    // here is that it names the crate only by its public paths.
    for file in [example().join("src").join("extension.rs"), Path::new(env!("CARGO_MANIFEST_DIR")).join("examples").join("echo.rs")] {
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(!text.contains("crate::"), "{} reaches inside a crate", file.display());
        assert!(text.contains("suiterun::"), "{} does not use the crate", file.display());
    }
}
