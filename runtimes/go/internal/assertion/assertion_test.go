package assertion

import (
	"strings"
	"testing"
)

// The corpus table in conformance/asserts is the specification and is
// enumerated by the conformance package. What is here is the rest: how a
// refusal reads, and what a failed assertion says a person should look at.

func TestARefusalReadsWithItsCodeWhenItHasOne(t *testing.T) {
	if plain("it cannot be compared").Error() != "it cannot be compared" {
		t.Error("a plain refusal")
	}
	if coded("E308", "the pattern").Error() != "E308: the pattern" {
		t.Error("a coded refusal")
	}
}

func TestAnUnportablePatternIsNamedByWhatMakesItUnportable(t *testing.T) {
	for _, row := range []struct {
		pattern string
		want    string
	}{
		{`(a)\1`, "a backreference"},
		{`a(?=b)`, "a lookahead"},
		{`a(?!b)`, "a lookahead"},
		{`(?<=a)b`, "a lookbehind"},
		{`(?<!a)b`, "a lookbehind"},
		{`^[A-Z]+-\d+$`, ""},
		{`.*`, ""},
	} {
		if got := Unportable(row.pattern); got != row.want {
			t.Errorf("%s is %q, wanted %q", row.pattern, got, row.want)
		}
	}
}

func TestAPatternThatWillNotCompileIsRefusedRatherThanFailed(t *testing.T) {
	_, failure := Compare("matches", "x", "([", true)
	if failure == nil || !strings.Contains(failure.Message, "cannot be read") {
		t.Errorf("an illegal pattern gave %v", failure)
	}
	_, failure = Compare("matches", "x", `(a)\1`, true)
	if failure == nil || failure.Code != "E308" {
		t.Errorf("an unportable pattern gave %v", failure)
	}
}

func TestAnOperatorNobodyImplementsSaysSo(t *testing.T) {
	_, failure := Compare("isBlue", "x", "y", true)
	if failure == nil || !strings.Contains(failure.Message, "Unknown assertion") {
		t.Errorf("an unknown operator gave %v", failure)
	}
}

func TestAFlagOperatorReadsItsOwnExpectedValue(t *testing.T) {
	for _, row := range []struct {
		expected any
		want     bool
	}{
		{true, true},
		{false, false},
		{nil, false},
		{"", false},
		{"0", false},
		{"yes", true},
		{int64(1), true},
	} {
		if got := truthOf(row.expected); got != row.want {
			t.Errorf("%v (%T) reads as %v", row.expected, row.expected, got)
		}
	}
}

func TestAFailureSaysWhatWasWantedAndWhatWasThere(t *testing.T) {
	for _, row := range []struct {
		operator string
		expected any
		actual   any
		present  bool
		want     []string
	}{
		{"equals", "Up", "Down", true, []string{"expected s equals 'Up'", "got 'Down'"}},
		{"isTrue", true, false, true, []string{"to be true", "got 'false'"}},
		{"isFalse", true, true, true, []string{"to be false"}},
		{"isNull", true, nil, true, []string{"absent or null", "(null)"}},
		{"isNotNull", true, nil, false, []string{"to be present", "(absent)"}},
		{"count", int64(3), []any{"a", "b"}, true, []string{"to have 3 entries", "[a, b]"}},
		{"in", []any{"a", "b"}, "c", true, []string{"[a, b]"}},
	} {
		said := Describe("s", row.operator, row.expected, row.actual, row.present)
		for _, want := range row.want {
			if !strings.Contains(said, want) {
				t.Errorf("%s said %q, which does not carry %q", row.operator, said, want)
			}
		}
	}
}

func TestTheOperatorListIsWhatTheComparerImplements(t *testing.T) {
	operators := Operators()
	if len(operators) != 18 {
		t.Errorf("%d operators", len(operators))
	}
	for _, name := range operators {
		if name == "script" {
			// Implemented by the PowerShell binding only, and refused here by
			// the executor rather than by the comparer.
			continue
		}
		if _, failure := Compare(name, "1", "1", true); failure != nil && failure.Code == "" &&
			strings.Contains(failure.Message, "Unknown assertion") {
			t.Errorf("%s is listed and not implemented", name)
		}
	}
}
