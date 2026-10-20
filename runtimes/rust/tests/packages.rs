//! The name filter, run progress and its observer, the action worker and the
//! embedded core (docs/packages, D4; spec/progress.md): the parts the corpus
//! does not reach.

mod common;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use suiterun::exec::{self, CaseResult, Observer, RunExtensions, SharedObserver};
use suiterun::trace::{Entry, Phase, Reason, Status, Trace};
use suiterun::{cli, model, progress, schema, suite};

/// The tests that point the progress writer elsewhere, one at a time.
static WRITER: Mutex<()> = Mutex::new(());

#[test]
fn name_and_progress_are_read_and_named_in_the_usage() {
    let parsed = cli::parse(
        ["run", "--path", "x.yml", "--name", " place-* , order-? ,", "--name", "third", "--progress"].map(String::from),
    )
    .unwrap();
    assert_eq!(parsed.names, ["place-*", "order-?", "third"]);
    assert!(parsed.progress);
    assert!(cli::usage().contains("[--name a*,b?]") && cli::usage().contains("[--progress]"));
}

#[test]
fn a_name_matches_a_glob_over_the_whole_name() {
    for (name, glob, matches) in [
        ("place-an-order", "*-an-order", true),
        ("order-1", "order-?", true),
        ("order-22", "order-?", false),
        ("read-the-stock", "*-an-order", false),
        ("Place-an-order", "place-*", false),
    ] {
        assert_eq!(suite::name_matches(name, &[glob.to_string()]), matches, "{name} against {glob}");
    }
    assert!(suite::name_matches("anything", &[]));
}

#[test]
fn a_trace_tells_its_hook_every_entry_in_order() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let told = seen.clone();
    let mut trace = Trace::observed(Some(Arc::new(move |entry: &Entry| {
        told.lock().unwrap().push(entry.step.clone().unwrap_or_default())
    })));
    trace.add(Phase::Step, Some("a"), Some("first"), Some("core.noop"), Status::Passed, None);
    trace.add(Phase::Step, Some("a"), Some("second"), Some("core.noop"), Status::Passed, None);
    assert_eq!(*seen.lock().unwrap(), ["first", "second"]);
    assert_eq!(trace.entries.len(), 2);
}

#[derive(Default)]
struct Recorder(Mutex<Vec<String>>);

impl Observer for Recorder {
    fn case_started(&self, suite: &str, case: &str) {
        self.0.lock().unwrap().push(format!("start {suite}::{case}"));
    }
    fn case_finished(&self, suite: &str, result: &CaseResult) {
        self.0.lock().unwrap().push(format!("end {suite}::{} {}", result.name, result.status.as_str()));
    }
    fn entry(&self, entry: &Entry) {
        self.0.lock().unwrap().push(format!("entry {} {}", entry.phase.as_str(), entry.case.clone().unwrap_or_default()));
    }
}

/// One corpus suite, the whole-file way.
fn run_file(relative: &str, options: &exec::Options, trace: &mut Trace) -> exec::SuiteResult {
    let path = common::corpus().join(relative);
    let model = model::load(&std::fs::read_to_string(&path).unwrap()).unwrap().value;
    let schema = schema::load(&common::corpus_schema()).unwrap();
    let registry = common::corpus_registry();
    exec::run_file(&path, &model, &schema, options, trace, &RunExtensions::new(&registry, &BTreeMap::new())).unwrap()
}

#[test]
fn an_observer_hears_selected_cases_only_and_never_changes_the_trace() {
    let filters = exec::Options { tags: vec!["wanted".into()], names: vec!["*-order".into()], ..exec::Options::default() };
    let mut plain = Trace::default();
    run_file("execute/names-and-tags.yml", &filters, &mut plain);
    let recorder = Arc::new(Recorder::default());
    let observed_options = exec::Options { observer: Some(SharedObserver(recorder.clone())), ..filters.clone() };
    let mut observed = Trace::default();
    run_file("execute/names-and-tags.yml", &observed_options, &mut observed);
    assert_eq!(plain.to_json(), observed.to_json());
    assert_eq!(
        *recorder.0.lock().unwrap(),
        [
            "start names-and-tags::a-wanted-order",
            "entry step a-wanted-order",
            "entry case a-wanted-order",
            "end names-and-tags::a-wanted-order passed",
            "entry case an-unwanted-order",
            "entry case a-wanted-refund",
        ]
    );
}

#[test]
fn a_dry_run_tells_the_observer_nothing() {
    let recorder = Arc::new(Recorder::default());
    let options = exec::Options { dry_run: true, observer: Some(SharedObserver(recorder.clone())), ..exec::Options::default() };
    run_file("execute/hooks.yml", &options, &mut Trace::default());
    assert!(recorder.0.lock().unwrap().is_empty());
}

#[test]
fn the_progress_printer_writes_the_specified_shape() {
    let _one = WRITER.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let printed = common::Captured::default();
    let standard = progress::set_writer(Some(Box::new(printed.clone())));
    let printer = progress::ProgressPrinter::new();
    let entry = |phase, case: Option<&str>, step: Option<&str>, action: Option<&str>, status, reason| Entry {
        phase,
        case: case.map(String::from),
        step: step.map(String::from),
        action: action.map(String::from),
        status,
        reason,
    };
    let result = |name: &str, status, message: &str, duration_sec| CaseResult {
        name: name.to_string(),
        status,
        message: message.to_string(),
        duration_sec,
        reason: None,
        output: String::new(),
        after_each_failed: false,
    };
    printer.entry(&entry(Phase::SuiteSetup, None, Some("step 1 (core.record)"), Some("core.record"), Status::Passed, None));
    printer.case_started("orders", "place");
    printer.entry(&entry(Phase::Step, Some("place"), Some("the order"), Some("shop.order"), Status::Failed, Some(Reason::Action)));
    printer.entry(&entry(Phase::Case, Some("place"), None, None, Status::Failed, Some(Reason::Action)));
    printer.case_finished("orders", &result("place", Status::Failed, "two\r\nlines", 2.6));
    printer.case_finished("orders", &result("later", Status::Skipped, "", 0.0));
    printer.case_finished("orders", &result("ok", Status::Passed, "", 0.5));
    printer.case_finished("orders", &result("silent", Status::Error, "", 0.0));
    printer.summary();
    progress::set_writer(standard);
    assert_eq!(
        printed.lines(),
        [
            "    suite-setup   step 1 (core.record) passed",
            "StartGroup: orders::place",
            "    step          the order (shop.order) failed [action]",
            "    failure: two lines",
            "EndGroup: orders::place [Failed] (3s)",
            "EndGroup: orders::later [Skipped] (0s)",
            "EndGroup: orders::ok [Passed] (1s)",
            "EndGroup: orders::silent [Failed] (0s)",
            "Summary: Total=4, Passed=1, Failed=2, Blocked=0, Not Run=0, Skipped=1",
        ]
    );
}

#[test]
fn by_default_progress_goes_to_standard_output() {
    let _one = WRITER.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let before = progress::set_writer(None);
    assert!(before.is_none(), "a writer was left set: progress goes to standard output only when none is");
}

#[test]
fn a_run_without_progress_prints_nothing_and_one_with_it_summarises_every_file() {
    let _one = WRITER.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let printed = common::Captured::default();
    let standard = progress::set_writer(Some(Box::new(printed.clone())));
    let corpus = common::corpus();
    let schema_root = common::corpus_schema().to_string_lossy().to_string();
    let quiet = common::run_cli(
        &["run", "--schema-root", &schema_root, "--path", &corpus.join("execute/hooks.yml").to_string_lossy()].map(String::from),
    );
    let quiet_lines = printed.lines();
    // Three files in sorted order; the filter selects nothing in the first.
    let names = corpus.join("execute").join("names*.yml").to_string_lossy().to_string();
    let loud = common::run_cli(
        &["run", "--schema-root", &schema_root, "--path", &names, "--name", "first,*-an-order", "--progress"].map(String::from),
    );
    progress::set_writer(standard);
    assert_eq!((quiet.0, quiet_lines.len()), (0, 0));
    let lines = printed.lines();
    let groups: Vec<&str> = lines.iter().filter_map(|line| line.strip_prefix("StartGroup: ")).collect();
    assert_eq!(loud.0, 0, "{}{}", loud.1, loud.2);
    assert_eq!(groups, ["names-none::first", "names::place-an-order", "names::cancel-an-order"]);
    assert_eq!(lines.last().unwrap(), "Summary: Total=3, Passed=3, Failed=0, Blocked=0, Not Run=0, Skipped=0");
}

#[test]
fn a_case_whose_action_panics_fails_and_the_run_carries_on() {
    let mut trace = Trace::default();
    let result = run_file("execute/worker-throws.yml", &exec::Options::default(), &mut trace);
    let summary: Vec<String> = result
        .cases
        .iter()
        .map(|case| format!("{}|{}|{}", case.name, case.status.as_str(), case.reason.map(Reason::as_str).unwrap_or_default()))
        .collect();
    assert_eq!(summary, ["the-case-whose-action-throws|failed|action", "the-case-after-it|passed|"]);
    assert!(result.cases[0].message.contains("thrown on purpose"), "{}", result.cases[0].message);
    let last = trace.entries.last().unwrap();
    assert_eq!((last.phase, last.status), (Phase::SuiteTeardown, Status::Passed));
}

#[test]
fn the_embedded_core_is_the_specs_and_bdd_suite_core_cuts_its_bindings() {
    let spec = std::fs::read_to_string(common::repo().join("spec").join("core.catalog.yaml")).unwrap();
    assert_eq!(
        schema::core_catalog_text().replace("\r\n", "\n"),
        spec.replace("\r\n", "\n"),
        "src/core.catalog.yaml differs from spec/core.catalog.yaml: copy the spec's again"
    );
    let cut = schema::load(&common::corpus().join("schema-core-import")).unwrap();
    let whole = schema::load(&common::corpus_schema()).unwrap();
    for name in ["core.noop", "core.set", "core.fail", "core.sleep", "core.record", "wait"] {
        assert_eq!(cut.actions[name].bindings, ["csharp"], "{name}");
        assert_eq!(whole.actions[name].bindings, ["powershell", "csharp", "go", "rust", "typescript"], "{name}");
    }
    assert_eq!(cut.actions.len(), 6);
}

#[test]
fn bdd_suite_core_is_read_whole_when_the_importer_lists_no_bindings() {
    let root = std::env::temp_dir().join(format!("suiterun-core-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("actions.catalog.yaml"), "catalogVersion: 1\nimports: [ 'bdd-suite:core' ]\n").unwrap();
    std::fs::copy(common::corpus().join("schema-core-import/suite.schema.json"), root.join("suite.schema.json")).unwrap();
    let loaded = schema::load(&root).unwrap();
    let _ = std::fs::remove_dir_all(&root);
    assert_eq!(loaded.actions["wait"].bindings.len(), 5);
}

#[test]
fn the_crate_carries_the_repositorys_license() {
    // A packaged crate holds only its own folder (docs/packages, DEC-P11).
    let root = std::fs::read_to_string(common::repo().join("LICENSE")).unwrap();
    let own = std::fs::read_to_string(common::repo().join("runtimes").join("rust").join("LICENSE")).unwrap();
    assert_eq!(
        own.replace("\r\n", "\n"),
        root.replace("\r\n", "\n"),
        "runtimes/rust/LICENSE differs from the repository's: copy it again"
    );
}
