// Package trace is what the run did, in the order it did it.
//
// Y3.3. A report says which cases passed; a trace says in which order the
// phases ran, which step a guard skipped, which row of a table failed and why.
// It holds no durations and no messages, because a trace two bindings compare
// cannot carry a number that differs by hardware or a sentence they are free to
// word differently.
package trace

import "github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"

// Phase is where in the run one entry happened.
type Phase string

const (
	SuiteSetup    Phase = "suite-setup"
	BeforeEach    Phase = "before-each"
	CaseSetup     Phase = "case-setup"
	Step          Phase = "step"
	CaseCleanup   Phase = "case-cleanup"
	AfterEach     Phase = "after-each"
	SuiteTeardown Phase = "suite-teardown"
	Case          Phase = "case"
)

// Status is what happened.
type Status string

const (
	Passed  Status = "passed"
	Failed  Status = "failed"
	Skipped Status = "skipped"
	Error   Status = "error"
)

// Reason is why, for anything that is not passed. A closed list, so four
// bindings categorise a failure the same way.
type Reason string

const (
	Assertion      Reason = "assertion"
	Timeout        Reason = "timeout"
	Action         Reason = "action"
	Hook           Reason = "hook"
	Cleanup        Reason = "cleanup"
	SuiteSetupFail Reason = "suite-setup"
	Tag            Reason = "tag"
	Guard          Reason = "guard"
	// None is the absence of a reason, which a passed entry carries.
	None Reason = ""
)

// Entry is one thing the run did.
type Entry struct {
	Phase  Phase
	Case   string
	Step   string
	Action string
	Status Status
	Reason Reason
}

// JSON is one entry as the trace schema defines it.
func (entry Entry) JSON() *model.Map {
	out := model.NewMap()
	out.Set("phase", string(entry.Phase))
	if entry.Case != "" {
		out.Set("case", entry.Case)
	}
	if entry.Step != "" {
		out.Set("step", entry.Step)
	}
	if entry.Action != "" {
		out.Set("action", entry.Action)
	}
	out.Set("status", string(entry.Status))
	if entry.Reason != None {
		out.Set("reason", string(entry.Reason))
	}
	return out
}

// Trace is everything the run did, in order.
type Trace struct {
	Entries []Entry
}

// Add records one thing the run did. An empty name is no name.
func (recorded *Trace) Add(phase Phase, caseName, step, action string, status Status, reason Reason) {
	recorded.Entries = append(recorded.Entries, Entry{
		Phase: phase, Case: caseName, Step: step, Action: action,
		Status: status, Reason: reason,
	})
}

// JSON is an array even when the run did one thing, and empty rather than
// absent when it did none.
func (recorded *Trace) JSON() []any {
	out := make([]any, 0, len(recorded.Entries))
	for _, entry := range recorded.Entries {
		out = append(out, entry.JSON())
	}
	return out
}
