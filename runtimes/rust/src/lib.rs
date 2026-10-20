//! The Rust runtime of the YAML suite runner.
//!
//! One suite format, one action catalog, one conformance corpus, several
//! runtimes. This crate is the Rust one; the corpus in this repository's
//! `conformance/` is what every runtime is held to.
//!
//! Nothing about the format is compiled in. The schema, the action catalog and
//! the corpus are read from files at run time, because a runtime carrying its
//! own copy of the vocabulary is a runtime that can drift from the others
//! without anybody noticing.
//!
//! A workspace adds to the runtime through the extension API
//! ([`extension::Extension`]): actions, context keys, options, rules and an
//! environment prefix. Its own `suiterun` is [`main_with`] called with its
//! extensions; this crate's `suiterun` is the same call with none.

pub mod actions;
pub mod assertions;
pub mod cli;
pub mod diag;
pub mod exec;
pub mod expr;
pub mod generate;
pub mod extension;
pub mod model;
pub mod paths;
pub mod report;
pub mod run;
pub mod schema;
pub mod session;
pub mod spelling;
pub mod suite;
#[cfg(feature = "testing")]
pub mod testing;
pub mod trace;
pub mod validate;
pub mod value;
pub mod walk;

pub use extension::{Action, Extension, ExtensionOption, Handler, Registry, RuleInput, RunState};

use std::io::Write;
use std::sync::Arc;

/// The three exit codes every runtime shares (DEC-Y14).
pub mod exit {
    /// Every selected case passed, or the validation found nothing.
    pub const PASSED: i32 = 0;
    /// A case failed. Only a run can produce this.
    pub const FAILED: i32 = 1;
    /// A validation error, or the harness could not do its job at all.
    pub const REFUSED: i32 = 2;
}

/// Runs one command line with the given extensions and gives back its exit
/// code; it never exits the process. Extensions that cannot be composed (a
/// name two of them define) and a command line that cannot be read are both
/// refused with 2 before anything runs.
pub fn main_with(
    arguments: Vec<String>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
    extensions: &[Arc<dyn Extension>],
) -> i32 {
    let registry = match Registry::compose(extensions) {
        Ok(registry) => registry,
        Err(refused) => {
            let _ = writeln!(stderr, "suiterun: {refused}");
            return exit::REFUSED;
        }
    };
    let options = match cli::parse_with(arguments, &registry) {
        Ok(options) => options,
        Err(refused) => {
            let _ = writeln!(stderr, "suiterun: {refused}");
            return exit::REFUSED;
        }
    };
    let report = run::execute_with(&options, &registry);
    if !report.out.is_empty() {
        let _ = writeln!(stdout, "{}", report.out);
    }
    if !report.errors.is_empty() {
        let _ = writeln!(stderr, "suiterun: {}", report.errors);
    }
    let _ = stdout.flush();
    let _ = stderr.flush();
    report.code
}
