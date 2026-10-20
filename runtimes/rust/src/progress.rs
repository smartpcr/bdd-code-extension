//! The live lines `run --progress` prints while a run is going
//! (spec/progress.md).
//!
//! A run of many lab suites takes hours, and the people and tools watching it
//! need to know which case is running and how the finished ones went before
//! the report is written at the end. The lines use the shape TAEF's console
//! output has, because existing lab tooling already parses it:
//!
//! ```text
//!     suite-setup   step 1 (core.record) passed
//! StartGroup: orders::place-an-order
//!     step          when the order is placed (shop.order) passed
//! EndGroup: orders::place-an-order [Passed] (3s)
//! Summary: Total=1, Passed=1, Failed=0, Blocked=0, Not Run=0, Skipped=0
//! ```
//!
//! Only selected cases are counted: a case the tag or name filter left out was
//! never part of this run.

use std::io::Write;
use std::sync::{Mutex, PoisonError};

use crate::exec::{CaseResult, Observer};
use crate::trace::{Entry, Phase, Status};

/// Where `--progress` writes its lines: standard output unless a test points
/// it elsewhere with [`set_writer`].
static WRITER: Mutex<Option<Box<dyn Write + Send>>> = Mutex::new(None);

/// Points the progress lines at `writer`, `None` for standard output again,
/// and hands back what was set before.
pub fn set_writer(writer: Option<Box<dyn Write + Send>>) -> Option<Box<dyn Write + Send>> {
    std::mem::replace(&mut *WRITER.lock().unwrap_or_else(PoisonError::into_inner), writer)
}

/// The observer behind `run --progress`.
#[derive(Default)]
pub struct ProgressPrinter {
    counts: Mutex<(usize, usize, usize)>,
}

impl ProgressPrinter {
    pub fn new() -> Self {
        Self::default()
    }

    /// The closing line, which the tooling reads as authoritative.
    pub fn summary(&self) {
        let (passed, failed, skipped) = *self.counts.lock().unwrap_or_else(PoisonError::into_inner);
        write(&format!(
            "Summary: Total={}, Passed={passed}, Failed={failed}, Blocked=0, Not Run=0, Skipped={skipped}",
            passed + failed + skipped
        ));
    }
}

impl Observer for ProgressPrinter {
    fn case_started(&self, suite: &str, case: &str) {
        write(&format!("StartGroup: {suite}::{case}"));
    }

    fn case_finished(&self, suite: &str, result: &CaseResult) {
        let verdict = match result.status {
            Status::Passed => "Passed",
            Status::Skipped => "Skipped",
            _ => "Failed",
        };
        {
            let mut counts = self.counts.lock().unwrap_or_else(PoisonError::into_inner);
            match verdict {
                "Passed" => counts.0 += 1,
                "Skipped" => counts.2 += 1,
                _ => counts.1 += 1,
            }
        }
        if verdict == "Failed" && !result.message.is_empty() {
            write(&format!("    failure: {}", result.message.replace("\r\n", " ").replace(['\n', '\r'], " ")));
        }
        // Rounded half away from zero, as the other runtimes round.
        write(&format!("EndGroup: {suite}::{} [{verdict}] ({}s)", result.name, result.duration_sec.round()));
    }

    /// One line per trace entry other than a case's result, so the last line
    /// of a log says what a long case is doing.
    fn entry(&self, entry: &Entry) {
        if entry.phase == Phase::Case {
            return;
        }
        let step = entry.step.as_deref().unwrap_or_default();
        // A step label written with a Gherkin keyword already ends in "(action)".
        let action = match entry.action.as_deref() {
            Some(action) if !step.contains(&format!("({action})")) => format!(" ({action})"),
            _ => String::new(),
        };
        let reason = entry.reason.map(|reason| format!(" [{}]", reason.as_str())).unwrap_or_default();
        write(&format!("    {:<13} {step}{action} {}{reason}", entry.phase.as_str(), entry.status.as_str()));
    }
}

/// One line, flushed, to the progress writer.
fn write(line: &str) {
    let mut writer = WRITER.lock().unwrap_or_else(PoisonError::into_inner);
    match writer.as_mut() {
        Some(writer) => {
            let _ = writeln!(writer, "{line}");
            let _ = writer.flush();
        }
        None => {
            let mut out = std::io::stdout().lock();
            let _ = writeln!(out, "{line}");
            let _ = out.flush();
        }
    }
}
