package report

import (
	"strings"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/exec"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/trace"
)

func sample() []exec.SuiteResult {
	return []exec.SuiteResult{{
		Name: "s.yml",
		Cases: []exec.CaseResult{
			{Name: "passes", Status: trace.Passed, Output: `"Up"`, DurationSec: 0.5},
			{Name: "fails", Status: trace.Failed, Message: "expected x equals 'y', got 'z'", DurationSec: 0.25},
			{Name: "skips", Status: trace.Skipped, Message: "tag filter"},
		},
	}}
}

func TestNunitCountsWhatHappened(t *testing.T) {
	document := NUnit3(sample())
	for _, want := range []string{
		`total="3"`, `passed="1"`, `failed="1"`, `skipped="1"`, `result="Failed"`,
		"<message>expected x equals &apos;y&apos;, got &apos;z&apos;</message>",
		"<output>&quot;Up&quot;</output>",
		"<reason>",
	} {
		if !strings.Contains(document, want) {
			t.Errorf("%s is missing from the report", want)
		}
	}
}

func TestJunitSaysTheSameThingWithDifferentElements(t *testing.T) {
	document := JUnit(sample())
	for _, want := range []string{
		`<testsuite name="s.yml" tests="3" failures="1" skipped="1">`,
		`<failure message="expected x equals &apos;y&apos;, got &apos;z&apos;">`,
		`<skipped message="tag filter">`,
		"<system-out>&quot;Up&quot;</system-out>",
	} {
		if !strings.Contains(document, want) {
			t.Errorf("%s is missing from the report", want)
		}
	}
}

func TestARunThatPassedSaysSoAtTheTop(t *testing.T) {
	suites := []exec.SuiteResult{{
		Name:  "s.yml",
		Cases: []exec.CaseResult{{Name: "c", Status: trace.Passed}},
	}}
	if !strings.Contains(NUnit3(suites), `result="Passed"`) {
		t.Error("a passing run")
	}
	if !strings.Contains(JUnit(suites), `failures="0"`) {
		t.Error("a passing JUnit run")
	}
	if !strings.Contains(NUnit3(nil), `total="0"`) {
		t.Error("a run of nothing")
	}
	if !strings.Contains(JUnit(nil), "<testsuites>") {
		t.Error("a JUnit run of nothing")
	}
}

func TestAnErroredCaseIsReportedAsAFailure(t *testing.T) {
	suites := []exec.SuiteResult{{
		Name:  "s.yml",
		Cases: []exec.CaseResult{{Name: "c", Status: trace.Error, Message: "Suite setup failed: x"}},
	}}
	document := NUnit3(suites)
	if !strings.Contains(document, `result="Failed"`) || !strings.Contains(document, "<failure>") {
		t.Errorf("an errored case reads as:\n%s", document)
	}
	if !strings.Contains(JUnit(suites), `failures="1"`) {
		t.Error("an errored case is not a JUnit failure")
	}
}

func TestTheFiveCharactersThatCannotAppearRawAreEscaped(t *testing.T) {
	if got := escape(`a&b<c>d"e'f`); got != "a&amp;b&lt;c&gt;d&quot;e&apos;f" {
		t.Errorf("escaping gives %q", got)
	}
	if !strings.HasSuffix(stamp(), "Z") {
		t.Errorf("the stamp is %q", stamp())
	}
}
