//! Spike: what a generated `harness = false` BDD test target could look like.
//!
//! Suites stand in for YAML suites. Behaviour is steered by env vars:
//!   SPIKE_SLEEP_MS        per-case sleep (default 100)
//!   SPIKE_FAIL_CASE       substring; cases whose title contains it fail
//!   SPIKE_FAIL_SETUP      suite name whose setup fails
//!   SPIKE_FAIL_TEARDOWN   suite name whose teardown fails
//!   SPIKE_FORCE_SERIAL=1  force test_threads = 1 (option a)
//!   SPIKE_SHOW_SELECTION=1 print the pre-computed selection before running
//!   SPIKE_QUIET=1         suppress per-step timestamp log
use libtest_mimic::{Arguments, Completion, Failed, Trial};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::process::ExitCode;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

static START: OnceLock<Instant> = OnceLock::new();
static EXECUTED: Mutex<Vec<String>> = Mutex::new(Vec::new());
static TEARDOWN_FAILURES: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn log(msg: &str) {
    if std::env::var_os("SPIKE_QUIET").is_some() {
        return;
    }
    let t = START.get().unwrap().elapsed().as_millis();
    eprintln!("[{t:>5}ms {:?}] {msg}", std::thread::current().id());
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

type Step = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

struct Case {
    title: String,
    ignored: bool,
    body: Step,
}

struct SuiteDef {
    name: String,
    setup: Step,
    cases: Vec<Case>,
    teardown: Step,
}

// ---------------------------------------------------------------- fixtures --

fn fixtures() -> Vec<SuiteDef> {
    let sleep_ms: u64 = env("SPIKE_SLEEP_MS").parse().unwrap_or(100);
    let mk_case = |title: &str, ignored: bool| {
        let t = title.to_string();
        Case {
            title: title.to_string(),
            ignored,
            body: Arc::new(move || {
                std::thread::sleep(Duration::from_millis(sleep_ms));
                let f = env("SPIKE_FAIL_CASE");
                if !f.is_empty() && t.contains(&f) {
                    return Err(format!("assertion failed in `{t}`"));
                }
                Ok(())
            }) as Step,
        }
    };
    let mk_hook = |suite: &str, var: &'static str, what: &'static str| {
        let s = suite.to_string();
        Arc::new(move || {
            std::thread::sleep(Duration::from_millis(20));
            if env(var) == s { Err(format!("{what} of `{s}` failed")) } else { Ok(()) }
        }) as Step
    };
    let suite = |name: &str, cases: Vec<Case>| SuiteDef {
        name: name.to_string(),
        setup: mk_hook(name, "SPIKE_FAIL_SETUP", "setup"),
        cases,
        teardown: mk_hook(name, "SPIKE_FAIL_TEARDOWN", "teardown"),
    };
    vec![
        suite("orders", vec![
            mk_case("places an order", false),
            mk_case("rejects a bad quantity [qty=0]", false),
            mk_case("rejects a bad quantity [qty=-1]", false),
            mk_case("cancels an order", false),
        ]),
        suite("billing", vec![
            mk_case("charges a card", false),
            mk_case("refunds a charge", false),
            mk_case("declines an expired card", false),
            mk_case("voids a charge", true), // ignored case
        ]),
        suite("inventory", vec![
            mk_case("reserves stock", false),
            mk_case("releases stock [sku=A-1]", false),
            mk_case("releases stock [sku=B-2]", false),
            mk_case("counts stock", false),
        ]),
    ]
}

// ------------------------------------------------------- per-suite runtime --

#[derive(Default)]
struct State {
    next_turn: usize,
    running: bool,
    setup: Option<Result<(), String>>,
}

/// A per-suite turnstile: the k-th *executing* unit of a suite waits until
/// units 0..k have finished. Units are numbered only among those that
/// libtest-mimic will actually execute (selected and not ignored).
struct SuiteRt {
    def: SuiteDef,
    turns: usize,
    state: Mutex<State>,
    cv: Condvar,
}

struct TurnGuard<'a>(&'a SuiteRt);

impl SuiteRt {
    fn acquire(&self, turn: usize) -> TurnGuard<'_> {
        let mut st = self.state.lock().unwrap();
        while st.next_turn != turn {
            st = self.cv.wait(st).unwrap();
        }
        assert!(!st.running, "two units of suite {} overlapped", self.def.name);
        st.running = true;
        TurnGuard(self)
    }
    fn setup_result(&self) -> Option<Result<(), String>> {
        self.state.lock().unwrap().setup.clone()
    }
    fn run_setup(&self) {
        log(&format!("{} SETUP", self.def.name));
        let r = guarded(&self.def.setup);
        self.state.lock().unwrap().setup = Some(r);
    }
    fn run_teardown(&self) -> Result<(), String> {
        log(&format!("{} TEARDOWN", self.def.name));
        guarded(&self.def.teardown)
    }
}

impl Drop for TurnGuard<'_> {
    // Runs on normal return and on unwind, so a panicking unit never blocks
    // the rest of its suite.
    fn drop(&mut self) {
        let mut st = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        st.running = false;
        st.next_turn += 1;
        self.0.cv.notify_all();
    }
}

fn guarded(step: &Step) -> Result<(), String> {
    catch_unwind(AssertUnwindSafe(|| step())).unwrap_or_else(|p| {
        let m = p
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_else(|| "panic".into());
        Err(format!("panicked: {m}"))
    })
}

// ------------------------------------------------------------------ trials --

enum Unit {
    Case(usize),
    Teardown,
}

fn case_trial(rt: Arc<SuiteRt>, idx: usize, turn: Option<usize>, name: String) -> Trial {
    let ignored = rt.def.cases[idx].ignored;
    Trial::ignorable_test(name.clone(), move || {
        let turn = turn.expect("libtest-mimic ran a trial we predicted it would not run");
        let _g = rt.acquire(turn);
        EXECUTED.lock().unwrap().push(name.clone());
        if turn == 0 {
            rt.run_setup();
        }
        let outcome = match rt.setup_result().unwrap() {
            Err(m) if turn == 0 => Err(Failed::from(format!("setup failed: {m}"))),
            Err(_) => Ok(Completion::ignored_with("suite setup failed")),
            Ok(()) => {
                log(&format!("{name} start"));
                let r = guarded(&rt.def.cases[idx].body);
                log(&format!("{name} end ({})", if r.is_ok() { "ok" } else { "FAILED" }));
                r.map(|()| Completion::Completed).map_err(Failed::from)
            }
        };
        // Last executing unit of the suite and it is a case => the teardown
        // trial was not selected, so this trial runs teardown on its behalf and
        // reports a failure out of band (never by failing this passed case).
        if turn + 1 == rt.turns {
            if let Err(m) = rt.run_teardown() {
                TEARDOWN_FAILURES.lock().unwrap().push(format!(
                    "{}::teardown failed (run after `{name}`; teardown trial not selected): {m}",
                    rt.def.name
                ));
            }
        }
        outcome
    })
    .with_ignored_flag(ignored)
}

fn teardown_trial(rt: Arc<SuiteRt>, turn: Option<usize>, name: String) -> Trial {
    Trial::ignorable_test(name.clone(), move || {
        let turn = turn.expect("libtest-mimic ran a trial we predicted it would not run");
        let _g = rt.acquire(turn);
        EXECUTED.lock().unwrap().push(name.clone());
        if rt.setup_result().is_none() {
            return Ok(Completion::ignored_with("no case of this suite was selected"));
        }
        rt.run_teardown()
            .map(|()| Completion::Completed)
            .map_err(|m| Failed::from(format!("teardown failed: {m}")))
    })
}

fn main() -> ExitCode {
    START.get_or_init(Instant::now);
    let mut args = Arguments::from_args();
    if env("SPIKE_FORCE_SERIAL") == "1" {
        args.test_threads = Some(1);
    }

    // Q1: compute the selection BEFORE running, with libtest-mimic's own
    // public predicates on probe trials that carry the same name/ignored flag.
    let mut predicted_run = Vec::new();
    let (mut predicted_ignored, mut predicted_filtered) = (0u64, 0u64);
    let mut per_suite: Vec<Vec<Trial>> = Vec::new();

    for def in fixtures() {
        let mut units: Vec<(String, bool, Unit)> = def
            .cases
            .iter()
            .enumerate()
            .map(|(i, c)| (format!("{}::{}", def.name, c.title), c.ignored, Unit::Case(i)))
            .collect();
        units.push((format!("{}::teardown", def.name), false, Unit::Teardown));

        let mut turns = Vec::new();
        let mut next = 0;
        for (name, ignored, _) in &units {
            let probe = Trial::test(name.clone(), || Ok(())).with_ignored_flag(*ignored);
            if args.is_filtered_out(&probe) {
                predicted_filtered += 1;
                turns.push(None);
            } else if args.is_ignored(&probe) {
                predicted_ignored += 1;
                turns.push(None);
            } else {
                predicted_run.push(name.clone());
                turns.push(Some(next));
                next += 1;
            }
        }
        let rt = Arc::new(SuiteRt { def, turns: next, state: Mutex::default(), cv: Condvar::new() });
        per_suite.push(
            units
                .into_iter()
                .zip(turns)
                .map(|((name, _, u), turn)| match u {
                    Unit::Case(i) => case_trial(rt.clone(), i, turn, name),
                    Unit::Teardown => teardown_trial(rt.clone(), turn, name),
                })
                .collect(),
        );
    }

    if env("SPIKE_SHOW_SELECTION") == "1" {
        eprintln!("[selection] will execute ({}): {predicted_run:#?}", predicted_run.len());
        eprintln!("[selection] ignored={predicted_ignored} filtered_out={predicted_filtered}");
    }

    // Interleave suites round-robin; libtest-mimic dispatches in Vec order,
    // so every unit's predecessors are already claimed by some worker.
    let mut trials = Vec::new();
    let mut iters: Vec<_> = per_suite.into_iter().map(|v| v.into_iter()).collect();
    loop {
        let before = trials.len();
        for it in iters.iter_mut() {
            trials.extend(it.next());
        }
        if trials.len() == before {
            break;
        }
    }

    let conclusion = libtest_mimic::run(&args, trials);
    if args.list {
        return ExitCode::SUCCESS;
    }

    let mut executed = EXECUTED.lock().unwrap().clone();
    executed.sort();
    predicted_run.sort();
    eprintln!(
        "[selection-check] predicted run={} ignored={} filtered_out={} | actual executed={} filtered_out={} | match={}",
        predicted_run.len(),
        predicted_ignored,
        predicted_filtered,
        executed.len(),
        conclusion.num_filtered_out,
        executed == predicted_run && predicted_filtered == conclusion.num_filtered_out
    );

    let td = TEARDOWN_FAILURES.lock().unwrap();
    for f in td.iter() {
        eprintln!("error: {f}");
    }
    if conclusion.has_failed() || !td.is_empty() { ExitCode::from(101) } else { ExitCode::SUCCESS }
}
