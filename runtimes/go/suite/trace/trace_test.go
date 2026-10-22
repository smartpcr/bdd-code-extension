package trace

import (
	"encoding/json"
	"testing"
)

func TestAnEntryCarriesOnlyWhatTheContractNames(t *testing.T) {
	recorded := &Trace{}
	recorded.Add(Step, "c", "when x (core.noop)", "core.noop", Passed, None)
	recorded.Add(Case, "c", "", "", Failed, Assertion)
	text, err := json.Marshal(recorded.JSON())
	if err != nil {
		t.Fatal(err)
	}
	var entries []map[string]any
	if err := json.Unmarshal(text, &entries); err != nil {
		t.Fatal(err)
	}
	if entries[0]["phase"] != "step" || entries[0]["action"] != "core.noop" {
		t.Errorf("the first is %v", entries[0])
	}
	if _, found := entries[0]["reason"]; found {
		t.Error("a passed entry carries a reason")
	}
	if entries[1]["status"] != "failed" || entries[1]["reason"] != "assertion" {
		t.Errorf("the second is %v", entries[1])
	}
	if _, found := entries[1]["step"]; found {
		t.Error("a case entry carries a step")
	}
}

func TestAnEmptyNameIsNoName(t *testing.T) {
	recorded := &Trace{}
	recorded.Add(SuiteSetup, "", "", "", Passed, None)
	entry := recorded.Entries[0].JSON()
	for _, key := range []string{"case", "step", "action"} {
		if entry.Has(key) {
			t.Errorf("an empty %s was written", key)
		}
	}
}

func TestEveryPhaseStatusAndReasonHasTheNameTheSchemaUses(t *testing.T) {
	for _, pair := range [][2]string{
		{string(SuiteTeardown), "suite-teardown"},
		{string(BeforeEach), "before-each"},
		{string(CaseCleanup), "case-cleanup"},
		{string(CaseSetup), "case-setup"},
		{string(AfterEach), "after-each"},
		{string(Case), "case"},
		{string(SuiteSetup), "suite-setup"},
		{string(Step), "step"},
		{string(Error), "error"},
		{string(Skipped), "skipped"},
		{string(Passed), "passed"},
		{string(Failed), "failed"},
		{string(SuiteSetupFail), "suite-setup"},
		{string(Guard), "guard"},
		{string(Skip), "skip"},
		{string(Cleanup), "cleanup"},
		{string(Hook), "hook"},
		{string(Tag), "tag"},
		{string(Action), "action"},
		{string(Timeout), "timeout"},
		{string(Assertion), "assertion"},
	} {
		if pair[0] != pair[1] {
			t.Errorf("%q is written as %q", pair[1], pair[0])
		}
	}
	if len((&Trace{}).JSON()) != 0 {
		t.Error("an empty trace is not an empty array")
	}
	text, err := json.Marshal((&Trace{}).JSON())
	if err != nil || string(text) != "[]" {
		t.Errorf("an empty trace serialises to %s", text)
	}
}
