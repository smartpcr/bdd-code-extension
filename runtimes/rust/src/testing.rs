//! Suite cases as `cargo test` tests (docs/test-providers, D10 and DEC-T11).
//! Behind the `testing` feature.
//!
//! A test crate generates in its `build.rs` and runs in a `harness = false`
//! test target:
//!
//! ```text
//! # Cargo.toml
//! [build-dependencies]
//! suiterun = { ..., features = ["testing"] }
//! [dev-dependencies]
//! suiterun = { ..., features = ["testing"] }
//! [[test]]
//! name = "suites"
//! harness = false
//!
//! // build.rs
//! fn main() { suiterun::testing::build("bddsuite.tests.yaml", "suites.rs"); }
//!
//! // tests/suites.rs
//! fn main() -> std::process::ExitCode {
//!     suiterun::testing::main(vec![std::sync::Arc::new(my::Extension)], include!(concat!(env!("OUT_DIR"), "/suites.rs")))
//! }
//! ```
//!
//! Each case and examples row is one trial named `<suite id>::<case name>`,
//! and each suite has a last `<suite id>::teardown` trial. `cargo test` then
//! lists, filters (`-- --exact`, `--skip`), runs in parallel and reports as it
//! does any test. libtest has no "before all" or "after all", so the harness
//! gives each suite a turnstile: the trials that will run (predicted before
//! the run with libtest-mimic's own `is_filtered_out` and `is_ignored`) take
//! turns, so a suite's cases run in order and never overlap while different
//! suites run on different threads. The suite setup runs in its first case and
//! the teardown in its teardown trial; when that trial is filtered out, the
//! last case that runs does the teardown, prints a failure to stderr, and the
//! harness exits 101. libtest-mimic is pinned at `=0.8.2`: the turnstile
//! cannot deadlock only because that version hands trials to its threads in
//! list order.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError};

use libtest_mimic::{Arguments, Completion, Failed, Trial};

use crate::exec::{RunContext, Session};
use crate::extension::{Extension, Registry};
use crate::generate as plan;
use crate::schema::{self, Schema};
use crate::trace::Status;

/// One planned suite, as `build.rs` writes it for the harness to include.
#[derive(Debug, Clone, Copy)]
pub struct Suite {
    /// The plan's identifier, the first part of every trial name.
    pub id: &'static str,
    /// The name the suite declares.
    pub name: &'static str,
    /// The suite file.
    pub file: &'static str,
    /// The file as findings name it: relative to the config's folder.
    pub shown: &'static str,
    pub schema_root: &'static str,
    /// Whether the plan marks the suite guarded (spec/session.md, rule 9).
    pub guarded: bool,
    /// The case names in file order, examples rows in row order.
    pub cases: &'static [&'static str],
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// --------------------------------------------------------------- generation --

/// The Rust a harness includes for one config, and the paths whose change
/// changes it. Suite paths are written relative to `base`, the test crate's
/// manifest folder, when it is given. A suite that does not lint clean, or a
/// config that names another provider, is refused with the reason.
pub fn generate_in(config: &Path, base: Option<&Path>) -> Result<(String, Vec<PathBuf>), String> {
    let loaded = plan::load_config(config)?;
    if let Some(provider) = loaded.provider.as_deref().filter(|provider| *provider != "rust") {
        return Err(format!(
            "{} names the {provider} provider; the Rust runtime generates for rust.",
            config.display()
        ));
    }
    let watched = plan::watched(&loaded);
    match plan::build(&loaded)? {
        Ok(built) => Ok((plan::render(&[built], base), watched)),
        Err(findings) => {
            let mut lines: Vec<String> = findings.iter().map(|finding| finding.to_human()).collect();
            lines.push(format!(
                "Nothing was generated from {}: every suite has to lint clean first.",
                config.display()
            ));
            Err(lines.join("\n"))
        }
    }
}

/// The Rust a harness includes for one config, with suite paths relative to
/// the crate being built (`CARGO_MANIFEST_DIR`) when there is one.
pub fn generate(config: impl AsRef<Path>) -> Result<String, String> {
    let base = std::env::var_os("CARGO_MANIFEST_DIR").map(PathBuf::from);
    generate_in(config.as_ref(), base.as_deref()).map(|(code, _)| code)
}

/// For `build.rs`: generates from `config` (relative to the crate) into
/// `$OUT_DIR/<output>`, rewriting it only when it changed, and tells Cargo to
/// run the build script again when the config, a suite folder or the schema
/// changes. A suite that does not lint clean stops the build with its
/// findings, so no test runs from a partial plan.
pub fn build(config: &str, output: &str) {
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("suiterun::testing::build runs in a build script"));
    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").expect("suiterun::testing::build runs in a build script"));
    let path = plan::clean(&manifest.join(config));
    println!("cargo:rerun-if-changed={}", path.display());
    match generate_in(&path, Some(&manifest)) {
        Ok((code, watched)) => {
            for one in watched {
                println!("cargo:rerun-if-changed={}", one.display());
            }
            let target = out_dir.join(output);
            if std::fs::read_to_string(&target).ok().as_deref() != Some(code.as_str()) {
                if let Err(failure) = std::fs::write(&target, code) {
                    eprintln!("{} cannot be written: {failure}", target.display());
                    std::process::exit(1);
                }
            }
        }
        Err(refused) => {
            eprintln!("{refused}");
            std::process::exit(1);
        }
    }
}

// ------------------------------------------------------------------ running --

/// What every trial of one run shares, made once and kept for the process.
struct Shared {
    registry: &'static Registry,
    context: OnceLock<&'static RunContext<'static>>,
    schemas: Mutex<HashMap<String, Result<&'static Schema, String>>>,
    /// Teardowns that failed in a case trial (their own trial filtered out).
    teardown_failures: Mutex<Vec<String>>,
}

impl Shared {
    /// The run context, built from the environment the first time a trial
    /// runs, so `--list` starts no extension.
    fn context(&self) -> &'static RunContext<'static> {
        self.context
            .get_or_init(|| Box::leak(Box::new(RunContext::from_environment(self.registry))))
    }

    fn schema(&self, root: &str) -> Result<&'static Schema, String> {
        locked(&self.schemas)
            .entry(root.to_string())
            .or_insert_with(|| schema::load(Path::new(root)).map(|loaded| &*Box::leak(Box::new(loaded))))
            .clone()
    }
}

#[derive(Default)]
struct Turns {
    next: usize,
    running: bool,
}

/// One suite's turnstile and session. Units are numbered among the trials
/// that will run; the k-th waits until units 0 to k-1 are done.
struct SuiteRun {
    shared: &'static Shared,
    suite: &'static Suite,
    units: usize,
    turns: Mutex<Turns>,
    turned: Condvar,
    session: OnceLock<Result<Session<'static>, String>>,
}

/// Advances the turn when a unit is done, even when it panicked, so a
/// panicking unit never blocks the rest of its suite.
struct Turn<'a>(&'a SuiteRun);

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        let mut turns = locked(&self.0.turns);
        turns.running = false;
        turns.next += 1;
        self.0.turned.notify_all();
    }
}

impl SuiteRun {
    fn take(&self, turn: usize) -> Turn<'_> {
        let mut turns = locked(&self.turns);
        while turns.next != turn {
            turns = self.turned.wait(turns).unwrap_or_else(PoisonError::into_inner);
        }
        assert!(!turns.running, "two trials of the suite {} overlapped", self.suite.id);
        turns.running = true;
        Turn(self)
    }

    /// The session, opened (and the file linted) by the suite's first unit.
    fn session(&self) -> Result<&Session<'static>, String> {
        self.session
            .get_or_init(|| {
                let schema = self.shared.schema(self.suite.schema_root)?;
                Session::open_linted(Path::new(self.suite.file), self.suite.shown, schema, self.shared.context(), self.suite.guarded)
            })
            .as_ref()
            .map_err(Clone::clone)
    }

    fn run_case(&self, index: usize, turn: usize) -> Result<Completion, Failed> {
        let _turn = self.take(turn);
        let outcome = match self.session() {
            Err(refused) => Err(Failed::from(refused)),
            Ok(session) => run_one(session, index),
        };
        // The last unit of the suite is this case: the teardown trial was
        // filtered out, so this one runs the teardown, and a failure is
        // reported beside the trials rather than by failing a case that did
        // nothing wrong.
        if turn + 1 == self.units {
            if let Ok(session) = self.session() {
                let teardown = session.teardown();
                if teardown.failed {
                    locked(&self.shared.teardown_failures).push(format!(
                        "{}::teardown failed (run after the last selected case; the teardown trial was not selected): {}",
                        self.suite.id, teardown.message
                    ));
                }
            }
        }
        outcome
    }

    fn run_teardown(&self, turn: usize) -> Result<Completion, Failed> {
        let _turn = self.take(turn);
        let Some(Ok(session)) = self.session.get() else {
            return Ok(Completion::ignored_with("no case of this suite ran, so neither does its teardown"));
        };
        let teardown = session.teardown();
        if !teardown.ran {
            return Ok(Completion::ignored_with("the suite setup did not run, so neither does its teardown"));
        }
        if teardown.failed {
            return Err(Failed::from(format!("The suite teardown of {} failed: {}", self.suite.name, teardown.message)));
        }
        Ok(Completion::Completed)
    }
}

/// One case through the session, as a trial's outcome.
fn run_one(session: &Session<'static>, index: usize) -> Result<Completion, Failed> {
    let mut guard = session.before_each(index).map_err(Failed::from)?;
    let ran = session.run_case(&mut guard);
    let result = session.after_each(guard);
    ran.map_err(Failed::from)?;
    match result.status {
        Status::Passed => Ok(Completion::Completed),
        Status::Skipped => Ok(Completion::ignored_with(result.message)),
        Status::Failed | Status::Error => Err(Failed::from(result.message)),
    }
}

/// The teardown trial's name: `teardown`, or `teardown_2` and on when a case
/// already has that name.
fn teardown_name(suite: &Suite) -> String {
    let mut name = "teardown".to_string();
    let mut number = 2;
    while suite.cases.contains(&name.as_str()) {
        name = format!("teardown_{number}");
        number += 1;
    }
    name
}

/// The harness: runs `suites` (what `build.rs` generated) as `cargo test`
/// trials with `extensions`, in a run context read from the environment
/// (spec/session.md: `BDD_SUITE_TAGS`, `BDD_SUITE_OPTION_<FLAG>`,
/// `BDD_SUITE_ALLOW_GUARDED`, `BDD_SUITE_TRACE_FILE`, ...), and writes the
/// trace when the run ends.
pub fn main(extensions: Vec<Arc<dyn Extension>>, suites: &'static [Suite]) -> ExitCode {
    let arguments = Arguments::from_args();
    let registry = match Registry::compose(&extensions) {
        Ok(registry) => &*Box::leak(Box::new(registry)),
        Err(refused) => {
            eprintln!("error: the extensions cannot be composed: {refused}");
            return ExitCode::from(101);
        }
    };
    let shared: &'static Shared = Box::leak(Box::new(Shared {
        registry,
        context: OnceLock::new(),
        schemas: Mutex::new(HashMap::new()),
        teardown_failures: Mutex::new(Vec::new()),
    }));

    let mut per_suite: Vec<Vec<Trial>> = Vec::new();
    for suite in suites {
        let names: Vec<String> = suite
            .cases
            .iter()
            .map(|case| format!("{}::{case}", suite.id))
            .chain([format!("{}::{}", suite.id, teardown_name(suite))])
            .collect();
        // The turn of every trial that will run, predicted with the harness's
        // own rules on a probe of the same name.
        let mut units = 0;
        let turns: Vec<Option<usize>> = names
            .iter()
            .map(|name| {
                let probe = Trial::test(name.clone(), || Ok(()));
                if arguments.is_filtered_out(&probe) || arguments.is_ignored(&probe) {
                    None
                } else {
                    units += 1;
                    Some(units - 1)
                }
            })
            .collect();
        let run = Arc::new(SuiteRun {
            shared,
            suite,
            units,
            turns: Mutex::new(Turns::default()),
            turned: Condvar::new(),
            session: OnceLock::new(),
        });
        let mut trials = Vec::new();
        for (index, (name, turn)) in names.into_iter().zip(turns).enumerate() {
            let run = run.clone();
            let is_teardown = index == suite.cases.len();
            trials.push(Trial::ignorable_test(name, move || {
                let turn = turn.expect("libtest-mimic ran a trial the harness predicted it would not run");
                if is_teardown {
                    run.run_teardown(turn)
                } else {
                    run.run_case(index, turn)
                }
            }));
        }
        per_suite.push(trials);
    }

    // Suites interleaved round-robin. libtest-mimic 0.8.2 hands trials to its
    // threads in list order, so every unit's predecessors are already taken by
    // a thread when it waits for its turn.
    let mut trials = Vec::new();
    let mut each: Vec<_> = per_suite.into_iter().map(Vec::into_iter).collect();
    loop {
        let before = trials.len();
        for one in each.iter_mut() {
            trials.extend(one.next());
        }
        if trials.len() == before {
            break;
        }
    }

    let conclusion = libtest_mimic::run(&arguments, trials);
    if arguments.list {
        return ExitCode::SUCCESS;
    }
    let written = match shared.context.get() {
        Some(context) => context.write_trace(),
        None => match std::env::var(format!("{}TRACE_FILE", registry.env_prefix())) {
            // Nothing ran, so the trace is empty, and still written.
            Ok(path) if !path.trim().is_empty() => std::fs::write(path.trim(), "[]\n").map_err(|failure| failure.to_string()),
            _ => Ok(()),
        },
    };
    let mut failed = conclusion.has_failed();
    if let Err(refused) = written {
        eprintln!("error: the trace cannot be written: {refused}");
        failed = true;
    }
    for failure in locked(&shared.teardown_failures).iter() {
        eprintln!("error: {failure}");
        failed = true;
    }
    if failed {
        ExitCode::from(101)
    } else {
        ExitCode::SUCCESS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_teardown_trial_avoids_a_case_of_the_same_name() {
        const PLAIN: Suite = Suite { id: "S", name: "s", file: "", shown: "", schema_root: "", guarded: false, cases: &["one"] };
        assert_eq!(teardown_name(&PLAIN), "teardown");
        let taken = Suite { cases: &["teardown", "teardown_2", "x"], ..PLAIN };
        assert_eq!(teardown_name(&taken), "teardown_3");
    }

    #[test]
    fn a_config_for_another_provider_is_refused() {
        let corpus = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/generate/bddsuite.tests.yaml");
        let refused = generate_in(&corpus, None).unwrap_err();
        assert!(refused.contains("names the mstest provider"), "{refused}");
    }

    #[test]
    fn a_config_whose_suite_does_not_lint_is_refused_with_the_finding() {
        let corpus = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/generate/invalid/bddsuite.tests.yaml");
        let refused = generate_in(&corpus, None).unwrap_err();
        assert!(refused.contains("suites/b-broken.yml:8:17  E104"), "{refused}");
        assert!(refused.contains("Nothing was generated"), "{refused}");
    }
}
