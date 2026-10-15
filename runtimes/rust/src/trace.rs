//! What the run did, in the order it did it.
//!
//! Y3.3. A report says which cases passed; a trace says in which order the
//! phases ran, which step a guard skipped, which row of a table failed and why.
//! It holds no durations and no messages, because a trace two bindings compare
//! cannot carry a number that differs by hardware or a sentence they are free
//! to word differently.

use serde_json::{Map, Value};

/// Where in the run one entry happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    SuiteSetup,
    BeforeEach,
    CaseSetup,
    Step,
    CaseCleanup,
    AfterEach,
    SuiteTeardown,
    Case,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::SuiteSetup => "suite-setup",
            Phase::BeforeEach => "before-each",
            Phase::CaseSetup => "case-setup",
            Phase::Step => "step",
            Phase::CaseCleanup => "case-cleanup",
            Phase::AfterEach => "after-each",
            Phase::SuiteTeardown => "suite-teardown",
            Phase::Case => "case",
        }
    }
}

/// What happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Passed,
    Failed,
    Skipped,
    Error,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Passed => "passed",
            Status::Failed => "failed",
            Status::Skipped => "skipped",
            Status::Error => "error",
        }
    }
}

/// Why, for anything that is not passed. A closed list, so four bindings
/// categorise a failure the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Assertion,
    Timeout,
    Action,
    Hook,
    Cleanup,
    SuiteSetup,
    Tag,
    Guard,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Assertion => "assertion",
            Reason::Timeout => "timeout",
            Reason::Action => "action",
            Reason::Hook => "hook",
            Reason::Cleanup => "cleanup",
            Reason::SuiteSetup => "suite-setup",
            Reason::Tag => "tag",
            Reason::Guard => "guard",
        }
    }
}

/// One thing the run did.
#[derive(Debug, Clone)]
pub struct Entry {
    pub phase: Phase,
    pub case: Option<String>,
    pub step: Option<String>,
    pub action: Option<String>,
    pub status: Status,
    pub reason: Option<Reason>,
}

impl Entry {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("phase".into(), self.phase.as_str().into());
        if let Some(case) = &self.case {
            map.insert("case".into(), case.clone().into());
        }
        if let Some(step) = &self.step {
            map.insert("step".into(), step.clone().into());
        }
        if let Some(action) = &self.action {
            map.insert("action".into(), action.clone().into());
        }
        map.insert("status".into(), self.status.as_str().into());
        if let Some(reason) = self.reason {
            map.insert("reason".into(), reason.as_str().into());
        }
        Value::Object(map)
    }
}

/// Everything the run did, in order.
#[derive(Debug, Default, Clone)]
pub struct Trace {
    pub entries: Vec<Entry>,
}

impl Trace {
    pub fn add(
        &mut self,
        phase: Phase,
        case: Option<&str>,
        step: Option<&str>,
        action: Option<&str>,
        status: Status,
        reason: Option<Reason>,
    ) {
        self.entries.push(Entry {
            phase,
            case: case.map(str::to_string).filter(|text| !text.is_empty()),
            step: step.map(str::to_string).filter(|text| !text.is_empty()),
            action: action.map(str::to_string).filter(|text| !text.is_empty()),
            status,
            reason,
        });
    }

    /// An array even when the run did one thing, and empty rather than absent
    /// when it did none.
    pub fn to_json(&self) -> Value {
        Value::Array(self.entries.iter().map(Entry::to_json).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_carries_only_what_the_contract_names() {
        let mut trace = Trace::default();
        trace.add(Phase::Step, Some("c"), Some("when x (core.noop)"), Some("core.noop"), Status::Passed, None);
        trace.add(Phase::Case, Some("c"), None, None, Status::Failed, Some(Reason::Assertion));
        let json = trace.to_json();
        let entries = json.as_array().unwrap();
        assert_eq!(entries[0]["phase"], "step");
        assert_eq!(entries[0]["action"], "core.noop");
        assert!(entries[0].get("reason").is_none());
        assert_eq!(entries[1]["status"], "failed");
        assert_eq!(entries[1]["reason"], "assertion");
        assert!(entries[1].get("step").is_none());
    }

    #[test]
    fn an_empty_name_is_no_name() {
        let mut trace = Trace::default();
        trace.add(Phase::SuiteSetup, Some(""), Some(""), Some(""), Status::Passed, None);
        let json = trace.to_json();
        assert!(json[0].get("case").is_none());
        assert!(json[0].get("step").is_none());
        assert!(json[0].get("action").is_none());
    }

    #[test]
    fn every_phase_status_and_reason_has_the_name_the_schema_uses() {
        assert_eq!(Phase::SuiteTeardown.as_str(), "suite-teardown");
        assert_eq!(Phase::BeforeEach.as_str(), "before-each");
        assert_eq!(Phase::CaseCleanup.as_str(), "case-cleanup");
        assert_eq!(Phase::CaseSetup.as_str(), "case-setup");
        assert_eq!(Phase::AfterEach.as_str(), "after-each");
        assert_eq!(Phase::Case.as_str(), "case");
        assert_eq!(Status::Error.as_str(), "error");
        assert_eq!(Status::Skipped.as_str(), "skipped");
        assert_eq!(Reason::SuiteSetup.as_str(), "suite-setup");
        assert_eq!(Reason::Guard.as_str(), "guard");
        assert_eq!(Reason::Cleanup.as_str(), "cleanup");
        assert_eq!(Reason::Hook.as_str(), "hook");
        assert_eq!(Reason::Tag.as_str(), "tag");
        assert_eq!(Reason::Action.as_str(), "action");
        assert_eq!(Reason::Timeout.as_str(), "timeout");
        assert_eq!(Trace::default().to_json().as_array().unwrap().len(), 0);
    }
}
