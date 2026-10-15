//! Where the tests find the corpus and its schema, and the extension the corpus
//! is run with. The corpus lives at the repository root (`conformance/`), with
//! its own catalog and schema (`conformance/schema`); this crate is
//! `runtimes/rust`, so both are two folders up from it.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use suiterun::{Extension, Registry, RunState};

/// This repository's root.
pub fn repo() -> PathBuf {
    let crate_folder = Path::new(env!("CARGO_MANIFEST_DIR"));
    crate_folder
        .parent()
        .and_then(Path::parent)
        .expect("the crate is runtimes/rust inside the repository")
        .to_path_buf()
}

pub fn corpus() -> PathBuf {
    repo().join("conformance")
}

pub fn corpus_schema() -> PathBuf {
    corpus().join("schema")
}

/// The core catalog every runtime implements exactly.
pub fn core_catalog() -> PathBuf {
    repo().join("spec").join("core.catalog.yaml")
}

/// The corpus's context keys (conformance/README.md): the core defines none
/// beyond timeoutSec and defaults, so the corpus declares the ones its suites
/// and expression table read, with the values of expressions/context.yaml.
pub struct CorpusExtension;

impl Extension for CorpusExtension {
    fn name(&self) -> &str {
        "the corpus"
    }

    fn context_keys(&self) -> Vec<String> {
        ["cluster", "target", "labId", "apiUrl"].map(str::to_string).to_vec()
    }

    fn start(&self, _options: &BTreeMap<String, String>) -> RunState {
        let context: BTreeMap<String, Value> = [
            ("cluster", json!("HOST-CL01")),
            ("target", json!("HOST-N1")),
            ("labId", json!("lab1")),
            ("apiUrl", json!("http://api/api/v1")),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_string(), value))
        .collect();
        RunState {
            context,
            ..RunState::default()
        }
    }
}

pub fn corpus_extensions() -> Vec<Arc<dyn Extension>> {
    vec![Arc::new(CorpusExtension)]
}

pub fn corpus_registry() -> Registry {
    Registry::compose(&corpus_extensions()).expect("the corpus extension composes")
}

/// The run manifest, parsed.
pub fn manifest() -> Value {
    suiterun::model::load(&std::fs::read_to_string(corpus().join("run-manifest.yaml")).unwrap())
        .unwrap()
        .value
}

/// One command line through the program with the corpus extension: exit code,
/// stdout and stderr.
pub fn run_cli(arguments: &[String]) -> (i32, String, String) {
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    let code = suiterun::main_with(arguments.to_vec(), &mut out, &mut err, &corpus_extensions());
    (code, String::from_utf8_lossy(&out).to_string(), String::from_utf8_lossy(&err).to_string())
}
