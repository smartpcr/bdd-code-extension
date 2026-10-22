//! The session's rules (spec/session.md), one test each, on small suites, and
//! the run context a test process builds from its environment.

mod common;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use suiterun::exec::{self, option_variable, Options, RunContext, RunExtensions, Session, GUARDED_MESSAGE};
use suiterun::schema::{self, Schema};
use suiterun::trace::{Reason, Status};
use suiterun::{model, Registry};

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// A suite file in a folder of its own, and the corpus schema.
fn suite(yaml: &str) -> (PathBuf, serde_json::Value) {
    let folder = std::env::temp_dir().join(format!("suiterun-session-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(&folder).unwrap();
    let path = folder.join("suite.yml");
    std::fs::write(&path, yaml).unwrap();
    (path, model::load(yaml).unwrap().value)
}

fn corpus_schema() -> Schema {
    schema::load(&common::corpus_schema()).unwrap()
}

fn context(registry: &Registry, options: Options) -> RunContext<'_> {
    RunContext::for_run(options, RunExtensions::new(registry, &BTreeMap::new()))
}

/// The trace as `phase case status` lines, steps left out.
fn phases(context: &RunContext) -> Vec<String> {
    context
        .trace()
        .entries
        .iter()
        .filter(|entry| entry.phase.as_str() != "step")
        .map(|entry| {
            format!(
                "{} {} {}",
                entry.phase.as_str(),
                entry.case.clone().unwrap_or_default(),
                entry.status.as_str()
            )
            .trim_end()
            .to_string()
        })
        .collect()
}

const HOOKED: &str = "
suite: hooked
setup: [ { action: core.noop } ]
beforeEach: [ { action: core.noop } ]
afterEach: [ { action: core.noop } ]
teardown: [ { action: core.noop } ]
tests:
  - name: one
    tags: [a]
    steps: [ { when: it works, action: core.noop } ]
  - name: two
    tags: [b]
    steps: [ { when: it works, action: core.noop } ]
";

#[test]
fn rule1_a_case_run_twice_is_refused_and_a_case_never_run_still_settles() {
    let (path, held) = suite(HOOKED);
    let (schema, registry) = (corpus_schema(), Registry::core());
    let context = context(&registry, Options::default());
    let session = Session::open(&path, held, &schema, &context, false).unwrap();
    let mut guard = session.before_each(0).unwrap();
    assert_eq!(session.run_case(&mut guard).unwrap().status, Status::Passed);
    let refused = session.run_case(&mut guard).unwrap_err();
    assert!(refused.contains("called twice"), "{refused}");
    assert_eq!(session.after_each(guard).status, Status::Passed);
    // beforeEach, then straight to afterEach: the case did not pass, and its
    // afterEach still ran.
    let guard = session.before_each(1).unwrap();
    let result = session.after_each(guard);
    assert_eq!((result.status, result.reason), (Status::Failed, Some(Reason::Hook)));
    assert!(result.message.contains("beforeEach but not the case itself"), "{}", result.message);
    assert!(session.before_each(9).err().unwrap().contains("no case number 9"));
    assert_eq!(session.index_of("two"), Some(1));
    assert_eq!(session.index_of("three"), None);
}

#[test]
fn rule2_setup_runs_once_however_often_it_is_called_and_before_each_runs_it() {
    let (path, held) = suite(HOOKED);
    let (schema, registry) = (corpus_schema(), Registry::core());
    let context = context(&registry, Options::default());
    let session = Session::open(&path, held, &schema, &context, false).unwrap();
    // No class-level hook called setup: the first beforeEach does.
    let mut guard = session.before_each(0).unwrap();
    session.run_case(&mut guard).unwrap();
    session.after_each(guard);
    session.setup();
    session.setup();
    assert_eq!(phases(&context).iter().filter(|line| line.starts_with("suite-setup")).count(), 1);
}

#[test]
fn rule2_nothing_selected_runs_neither_setup_nor_teardown() {
    let (path, held) = suite(HOOKED);
    let (schema, registry) = (corpus_schema(), Registry::core());
    let context = context(&registry, Options { tags: vec!["none".into()], ..Options::default() });
    let session = Session::open(&path, held, &schema, &context, false).unwrap();
    session.setup();
    for index in 0..2 {
        assert!(!session.is_selected(index));
        let mut guard = session.before_each(index).unwrap();
        session.run_case(&mut guard).unwrap();
        let result = session.after_each(guard);
        assert_eq!((result.status, result.reason, result.message.as_str()), (Status::Skipped, Some(Reason::Tag), "tag filter"));
    }
    assert!(!session.teardown().ran);
    assert_eq!(phases(&context), vec!["case one skipped", "case two skipped"]);
}

#[test]
fn rule3_a_failed_setup_is_recorded_and_every_case_reports_it() {
    let (path, held) = suite("
suite: s
setup: [ { action: core.fail, message: no lab } ]
teardown: [ { action: core.noop } ]
tests:
  - name: one
    steps: [ { action: core.noop } ]
");
    let (schema, registry) = (corpus_schema(), Registry::core());
    let context = context(&registry, Options::default());
    let session = Session::open(&path, held, &schema, &context, false).unwrap();
    session.setup();
    let mut guard = session.before_each(0).unwrap();
    let ran = session.run_case(&mut guard).unwrap();
    assert_eq!((ran.status, ran.reason), (Status::Error, Some(Reason::SuiteSetup)));
    assert!(ran.message.starts_with("Suite setup failed: suite setup"), "{}", ran.message);
    session.after_each(guard);
    // State a half-built setup left still has to be undone.
    assert!(session.teardown().ran);
}

#[test]
fn rule3_a_failed_before_each_is_recorded_and_the_case_still_cleans_up() {
    let (path, held) = suite("
suite: s
beforeEach: [ { action: core.fail, message: not ready } ]
afterEach: [ { action: core.noop } ]
tests:
  - name: one
    steps: [ { when: never, action: core.noop } ]
    cleanup: [ { action: core.noop } ]
");
    let (schema, registry) = (corpus_schema(), Registry::core());
    let context = context(&registry, Options::default());
    let session = Session::open(&path, held, &schema, &context, false).unwrap();
    let mut guard = session.before_each(0).unwrap();
    let ran = session.run_case(&mut guard).unwrap();
    assert_eq!((ran.status, ran.reason), (Status::Failed, Some(Reason::Hook)));
    let settled = session.after_each(guard);
    assert!(!settled.after_each_failed);
    assert_eq!(phases(&context), vec!["before-each one failed", "case-cleanup one passed", "after-each one passed", "case one failed"]);
}

#[test]
fn rule4_a_failed_after_each_settles_the_case_and_says_so() {
    let (path, held) = suite("
suite: s
afterEach: [ { action: core.fail, message: could not reset } ]
tests:
  - name: one
    steps: [ { action: core.noop } ]
");
    let (schema, registry) = (corpus_schema(), Registry::core());
    let context = context(&registry, Options::default());
    let session = Session::open(&path, held, &schema, &context, false).unwrap();
    let mut guard = session.before_each(0).unwrap();
    assert_eq!(session.run_case(&mut guard).unwrap().status, Status::Passed);
    let settled = session.after_each(guard);
    assert!(settled.after_each_failed);
    assert_eq!((settled.status, settled.reason), (Status::Failed, Some(Reason::Hook)));
    assert!(settled.message.contains("afterEach failed:"), "{}", settled.message);
}

#[test]
fn rule4_a_guard_dropped_without_after_each_still_runs_it() {
    let (path, held) = suite(HOOKED);
    let (schema, registry) = (corpus_schema(), Registry::core());
    let context = context(&registry, Options::default());
    let session = Session::open(&path, held, &schema, &context, false).unwrap();
    {
        let mut guard = session.before_each(0).unwrap();
        session.run_case(&mut guard).unwrap();
    }
    assert_eq!(&phases(&context)[2..], ["after-each one passed", "case one passed"]);
    // The lock was released: the next case starts.
    let guard = session.before_each(1).unwrap();
    session.after_each(guard);
}

#[test]
fn rule5_a_case_that_changes_a_captured_list_changes_it_for_itself_only() {
    let (path, held) = suite("
suite: s
setup: [ { action: core.set, value: { items: [a] }, captureAs: bag } ]
tests:
  - name: one
    steps:
      - { action: fixture.append, list: '${capture.bag.items}', item: b, captureAs: grown, asserts: [ { var: grown, count: 2 } ] }
  - name: two
    steps:
      - action: core.noop
        asserts: [ { var: bag.items, count: 1 } ]
");
    let schema = corpus_schema();
    let registry = common::corpus_registry();
    let context = context(&registry, Options::default());
    let session = Session::open(&path, held, &schema, &context, false).unwrap();
    for index in 0..2 {
        let mut guard = session.before_each(index).unwrap();
        session.run_case(&mut guard).unwrap();
        let result = session.after_each(guard);
        assert_eq!(result.status, Status::Passed, "{}: {}", result.name, result.message);
    }
}

#[test]
fn rule6_teardown_runs_once_and_only_after_a_setup() {
    let (path, held) = suite(HOOKED);
    let (schema, registry) = (corpus_schema(), Registry::core());
    let context = context(&registry, Options::default());
    let session = Session::open(&path, held, &schema, &context, false).unwrap();
    assert!(!session.teardown().ran, "no setup ran yet");
    session.setup();
    let first = session.teardown();
    assert!(first.ran && !first.failed);
    assert!(!session.teardown().ran, "a second call does nothing");
}

#[test]
fn rule6_a_failed_teardown_is_returned() {
    let (path, held) = suite("
suite: s
teardown: [ { action: core.fail, message: left a mess } ]
tests:
  - name: one
    steps: [ { action: core.noop } ]
");
    let (schema, registry) = (corpus_schema(), Registry::core());
    let context = context(&registry, Options::default());
    let session = Session::open(&path, held, &schema, &context, false).unwrap();
    let mut guard = session.before_each(0).unwrap();
    assert_eq!(session.run_case(&mut guard).unwrap().status, Status::Passed);
    assert_eq!(session.after_each(guard).status, Status::Passed);
    let teardown = session.teardown();
    assert!(teardown.ran && teardown.failed);
    assert!(teardown.message.contains("left a mess"), "{}", teardown.message);
}

#[test]
fn rule7_one_case_of_a_session_runs_at_a_time() {
    let (path, held) = suite("
suite: s
tests:
  - name: one
    steps: [ { action: core.record, marker: one-start }, { action: core.sleep, seconds: 0.2 }, { action: core.record, marker: one-end } ]
  - name: two
    steps: [ { action: core.record, marker: two-start }, { action: core.sleep, seconds: 0.2 }, { action: core.record, marker: two-end } ]
  - name: three
    steps: [ { action: core.record, marker: three-start }, { action: core.sleep, seconds: 0.2 }, { action: core.record, marker: three-end } ]
");
    let record = path.with_file_name("record.txt");
    let (schema, registry) = (corpus_schema(), Registry::core());
    let context = context(&registry, Options { record_path: Some(record.to_string_lossy().to_string()), ..Options::default() });
    let session = Session::open(&path, held, &schema, &context, false).unwrap();
    std::thread::scope(|scope| {
        for index in 0..3 {
            let session = &session;
            scope.spawn(move || {
                let mut guard = session.before_each(index).unwrap();
                session.run_case(&mut guard).unwrap();
                assert_eq!(session.after_each(guard).status, Status::Passed);
            });
        }
    });
    let markers: Vec<String> = std::fs::read_to_string(&record).unwrap().lines().map(str::to_string).collect();
    assert_eq!(markers.len(), 6, "{markers:?}");
    for pair in markers.chunks(2) {
        let name = pair[0].trim_end_matches("-start");
        assert_eq!(pair[1], format!("{name}-end"), "cases overlapped: {markers:?}");
    }
    // Each case's trace entries are one unbroken group.
    let cases: Vec<String> = context.trace().entries.iter().map(|entry| entry.case.clone().unwrap_or_default()).collect();
    let mut groups = cases.clone();
    groups.dedup();
    assert_eq!(groups.len(), 3, "{cases:?}");
}

#[test]
fn rule7_sessions_in_parallel_share_one_trace_without_losing_an_entry() {
    let (path, held) = suite(HOOKED);
    let (schema, registry) = (corpus_schema(), Registry::core());
    let context = context(&registry, Options::default());
    std::thread::scope(|scope| {
        for _ in 0..8 {
            let (path, held, schema, context) = (&path, held.clone(), &schema, &context);
            scope.spawn(move || {
                let session = Session::open(path, held, schema, context, false).unwrap();
                for index in 0..2 {
                    let mut guard = session.before_each(index).unwrap();
                    session.run_case(&mut guard).unwrap();
                    session.after_each(guard);
                }
                session.teardown();
            });
        }
    });
    // Per session: setup, two cases of four entries and a step each, teardown.
    assert_eq!(context.trace().entries.len(), 8 * (1 + 2 * 4 + 1));
}

#[test]
fn rule9_a_guarded_suite_skips_unless_the_run_allows_it() {
    let (path, held) = suite(HOOKED);
    let (schema, registry) = (corpus_schema(), Registry::core());
    let mut refusing = context(&registry, Options::default());
    refusing.allow_guarded = false;
    let session = Session::open(&path, held.clone(), &schema, &refusing, true).unwrap();
    session.setup();
    let mut guard = session.before_each(0).unwrap();
    session.run_case(&mut guard).unwrap();
    let result = session.after_each(guard);
    assert_eq!((result.status, result.reason, result.message.as_str()), (Status::Skipped, Some(Reason::Guard), GUARDED_MESSAGE));
    assert!(!session.teardown().ran);
    assert_eq!(phases(&refusing), vec!["case one skipped"]);

    let allowing = context(&registry, Options::default());
    let session = Session::open(&path, held, &schema, &allowing, true).unwrap();
    let mut guard = session.before_each(0).unwrap();
    session.run_case(&mut guard).unwrap();
    assert_eq!(session.after_each(guard).status, Status::Passed);
}

#[test]
fn rule10_a_dry_run_validates_and_traces_nothing() {
    let (path, held) = suite(HOOKED);
    let (schema, registry) = (corpus_schema(), Registry::core());
    let context = context(&registry, Options { dry_run: true, ..Options::default() });
    let session = Session::open(&path, held, &schema, &context, false).unwrap();
    session.setup();
    let mut guard = session.before_each(0).unwrap();
    session.run_case(&mut guard).unwrap();
    assert_eq!(session.after_each(guard).status, Status::Skipped);
    assert!(!session.teardown().ran);
    assert!(context.trace().entries.is_empty());
}

/// One case through beforeEach, the case and afterEach.
fn run_one(session: &Session, index: usize) -> exec::CaseResult {
    let mut guard = session.before_each(index).unwrap();
    session.run_case(&mut guard).unwrap();
    session.after_each(guard)
}

#[test]
fn rule12_a_skip_carries_its_message_and_ends_a_wait_rather_than_being_polled() {
    let (path, held) = suite("
suite: skips
tests:
  - name: at-a-step
    steps:
      - when: the lab cannot run it
        action: core.skip
        message: no-sbe-profile on this lab
  - name: inside-a-wait
    steps:
      - when: the polled step skips
        action: wait
        intervalSec: 1
        timeoutSec: 30
        forStep:
          action: core.skip
          message: skipped from a poll
");
    let (schema, registry) = (corpus_schema(), Registry::core());
    let context = context(&registry, Options::default());
    let session = Session::open(&path, held, &schema, &context, false).unwrap();
    let at_step = run_one(&session, 0);
    assert_eq!((at_step.status, at_step.reason), (Status::Skipped, Some(Reason::Skip)));
    assert!(at_step.message.contains("no-sbe-profile on this lab"), "{}", at_step.message);

    let started = std::time::Instant::now();
    let in_wait = run_one(&session, 1);
    assert_eq!((in_wait.status, in_wait.reason), (Status::Skipped, Some(Reason::Skip)));
    assert!(in_wait.message.contains("skipped from a poll"), "{}", in_wait.message);
    assert!(started.elapsed().as_secs() < 10, "the skip was polled again instead of ending the case");
}

#[test]
fn rule12_a_skip_outside_the_cases_own_setup_and_steps_is_that_hooks_failure() {
    let (path, held) = suite("
suite: skip-in-hooks
beforeEach:
  - action: core.skip
    message: not the case's decision
tests:
  - name: one
    steps:
      - then: it would run
        action: core.noop
");
    let (schema, registry) = (corpus_schema(), Registry::core());
    let context = context(&registry, Options::default());
    let session = Session::open(&path, held, &schema, &context, false).unwrap();
    let result = run_one(&session, 0);
    assert_eq!((result.status, result.reason), (Status::Failed, Some(Reason::Hook)));

    let (path, held) = suite("
suite: skip-then-cleanup-fails
tests:
  - name: one
    steps:
      - when: it skips
        action: core.skip
    cleanup:
      - action: core.fail
        message: the cleanup broke
");
    let context = self::context(&registry, Options::default());
    let session = Session::open(&path, held, &schema, &context, false).unwrap();
    let failed = run_one(&session, 0);
    assert_eq!((failed.status, failed.reason), (Status::Failed, Some(Reason::Cleanup)));
    assert!(failed.message.contains("the cleanup broke"), "{}", failed.message);
}

#[test]
fn rule12_an_extensions_action_skips_its_case_the_same_way() {
    struct Lab;
    impl suiterun::Extension for Lab {
        fn name(&self) -> &str {
            "lab"
        }
        fn actions(&self) -> Vec<suiterun::Action> {
            vec![suiterun::Action::new("lab.require", |_| {
                Err(suiterun::actions::ActionError::skipped("lab.require: this lab has no SBE profile"))
            })]
        }
    }
    let registry = Registry::compose(&[std::sync::Arc::new(Lab) as std::sync::Arc<dyn suiterun::Extension>]).unwrap();
    let (path, held) = suite("
suite: extension-skip
tests:
  - name: one
    steps:
      - given: the lab is checked
        action: lab.require
");
    let schema = corpus_schema();
    let context = context(&registry, Options::default());
    let session = Session::open(&path, held, &schema, &context, false).unwrap();
    let result = run_one(&session, 0);
    assert_eq!((result.status, result.reason), (Status::Skipped, Some(Reason::Skip)));
    assert!(result.message.contains("this lab has no SBE profile"), "{}", result.message);
}

#[test]
fn the_run_context_reads_options_tags_and_switches_under_the_prefix() {
    struct Lab;
    impl suiterun::Extension for Lab {
        fn name(&self) -> &str {
            "lab"
        }
        fn options(&self) -> Vec<suiterun::ExtensionOption> {
            vec![suiterun::ExtensionOption::new("--api-url", "The lab's API.")]
        }
    }
    let registry = Registry::compose(&[std::sync::Arc::new(Lab) as std::sync::Arc<dyn suiterun::Extension>]).unwrap();
    let values: BTreeMap<&str, &str> = [
        ("BDD_SUITE_OPTION_API_URL", "http://lab"),
        ("BDD_SUITE_TAGS", " smoke, ,lab "),
        ("BDD_SUITE_DRY_RUN", "1"),
        ("BDD_SUITE_ALLOW_GUARDED", "1"),
        ("BDD_SUITE_TRACE_FILE", "out/trace.json"),
        ("BDD_SUITE_RECORD_PATH", "out/record.txt"),
    ]
    .into_iter()
    .collect();
    let context = RunContext::from_lookup(&registry, |name| values.get(name).map(|value| value.to_string()));
    assert_eq!(option_variable("--api-url"), "API_URL");
    assert_eq!(context.options.tags, vec!["smoke".to_string(), "lab".to_string()]);
    assert!(context.options.dry_run && context.allow_guarded);
    assert_eq!(context.trace_file, Some(PathBuf::from("out/trace.json")));
    assert_eq!(context.options.record_path.as_deref(), Some("out/record.txt"));

    let quiet = RunContext::from_lookup(&registry, |_| None);
    assert!(quiet.options.tags.is_empty() && !quiet.options.dry_run && !quiet.allow_guarded && quiet.trace_file.is_none());
}

#[test]
fn write_trace_writes_where_the_run_context_says() {
    let (path, held) = suite(HOOKED);
    let (schema, registry) = (corpus_schema(), Registry::core());
    let mut context = context(&registry, Options::default());
    assert!(context.write_trace().is_ok(), "no file named: nothing to do");
    let file = path.with_file_name("nested").join("trace.json");
    context.trace_file = Some(file.clone());
    let session = Session::open(&path, held, &schema, &context, false).unwrap();
    let mut guard = session.before_each(0).unwrap();
    session.run_case(&mut guard).unwrap();
    session.after_each(guard);
    context.write_trace().unwrap();
    let written: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(written.as_array().unwrap().len(), context.trace().entries.len());
}

#[test]
fn a_test_process_refuses_a_suite_that_does_not_lint_clean() {
    let (path, _) = suite("
suite: s
tests:
  - name: one
    steps: [ { when: it works, action: core.nope } ]
");
    let (schema, registry) = (corpus_schema(), Registry::core());
    let context = context(&registry, Options::default());
    let refused = Session::open_linted(&path, "suite.yml", &schema, &context, false).err().unwrap();
    assert!(refused.contains("suite.yml:5:") && refused.contains("E104"), "{refused}");
    let (path, _) = suite(HOOKED);
    assert!(Session::open_linted(&path, "suite.yml", &schema, &context, false).is_ok());
}

#[test]
fn run_file_reports_a_failed_teardown_as_its_own_entry() {
    let (path, held) = suite("
suite: s
teardown: [ { action: core.fail } ]
tests:
  - name: one
    steps: [ { action: core.noop } ]
");
    let (schema, registry) = (corpus_schema(), Registry::core());
    let extensions = RunExtensions::new(&registry, &BTreeMap::new());
    let result = exec::run_file(&path, &held, &schema, &Options::default(), &mut Default::default(), &extensions).unwrap();
    let names: Vec<(&str, Status)> = result.cases.iter().map(|case| (case.name.as_str(), case.status)).collect();
    assert_eq!(names, vec![("one", Status::Passed), ("teardown", Status::Failed)]);
    assert_eq!(result.cases[1].reason, Some(Reason::Hook));
}
