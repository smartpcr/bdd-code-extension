package diag

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
)

func at(line, column int) model.Position { return model.NewPosition(line, column) }

func TestTheSortIsTotalSoTwoBindingsCannotDisagreeByOrdering(t *testing.T) {
	findings := []Diagnostic{
		NewError("E301", "b.yml", at(1, 1), "second file"),
		NewError("E105", "a.yml", at(4, 2), "later in a"),
		NewError("E101", "a.yml", at(4, 2), "same place, earlier code"),
		NewError("E101", "a.yml", at(4, 1), "same line, earlier column"),
		NewError("E101", "a.yml", at(2, 9), "earlier line"),
	}
	order := []string{}
	for _, finding := range Sorted(findings) {
		order = append(order, finding.Message)
	}
	want := "earlier line|same line, earlier column|same place, earlier code|later in a|second file"
	if strings.Join(order, "|") != want {
		t.Errorf("the order is %s", strings.Join(order, "|"))
	}
}

func TestTheSameFindingTwiceIsReportedOnce(t *testing.T) {
	findings := []Diagnostic{
		NewError("E103", "a.yml", at(6, 14), "refused"),
		NewError("E103", "a.yml", at(6, 14), "refused"),
		NewError("E103", "a.yml", at(6, 14), "refused differently"),
	}
	order := []string{}
	for _, finding := range Sorted(findings) {
		order = append(order, finding.Message)
	}
	if strings.Join(order, "|") != "refused|refused differently" {
		t.Errorf("the findings are %s", strings.Join(order, "|"))
	}
}

func TestAWarningOnlyFailsUnderStrict(t *testing.T) {
	warning := []Diagnostic{NewWarning("W301", "a.yml", at(1, 1), "unread")}
	if Fails(warning, false) {
		t.Error("a warning failed a plain lint")
	}
	if !Fails(warning, true) {
		t.Error("a warning passed a strict lint")
	}
	failure := []Diagnostic{NewError("E101", "a.yml", at(1, 1), "typo")}
	if !Fails(failure, false) || !Fails(failure, true) {
		t.Error("an error passed")
	}
	if Fails(nil, true) {
		t.Error("nothing failed")
	}
}

func TestAFindingReadsAsAPlaceAndACode(t *testing.T) {
	finding := NewError("E101", "a.yml", at(4, 7), "Unknown key tiemout.").Suggest("Did you mean timeout")
	human := finding.Human()
	if !strings.HasPrefix(human, "a.yml:4:7  E101  Unknown key tiemout.") {
		t.Errorf("the line reads %q", human)
	}
	if !strings.Contains(human, "\n    Did you mean timeout") {
		t.Error("the suggestion is not indented under it")
	}
	if NewError("E101", "a.yml", at(1, 1), "x").Suggest("").Suggestion != "" {
		t.Error("an empty suggestion was kept")
	}
}

func TestTheJsonIsWhatTheSchemaDefines(t *testing.T) {
	text := JSONArray([]Diagnostic{NewWarning("W301", "a.yml", at(2, 3), "unread")})
	for _, want := range []string{`"code": "W301"`, `"severity": "warning"`, `"line": 2`, `"column": 3`} {
		if !strings.Contains(text, want) {
			t.Errorf("%s is missing from %s", want, text)
		}
	}
	if strings.Contains(text, "suggestion") {
		t.Error("a finding with no suggestion carries the key anyway")
	}
	if JSONArray(nil) != "[]" {
		t.Errorf("nothing serialises to %s", JSONArray(nil))
	}
}

func TestAPathIsRelativeWithForwardSlashes(t *testing.T) {
	// Paths that are absolute on this platform: a drive letter is not one on Linux.
	root := filepath.Join(t.TempDir(), "work", "repo")
	if got := RelativePath(filepath.Join(root, "test", "a.yml"), root); got != "test/a.yml" {
		t.Errorf("under the root it is %q", got)
	}
	outside := RelativePath(filepath.Join(t.TempDir(), "elsewhere", "a.yml"), root)
	if strings.Contains(outside, `\`) {
		t.Errorf("outside the root it is %q", outside)
	}
	if runtime.GOOS == "windows" {
		if got := RelativePath(`C:\work\repo\test\a.yml`, `C:\work\repo`); got != "test/a.yml" {
			t.Errorf("under a drive root it is %q", got)
		}
		if other := RelativePath(`D:\elsewhere\a.yml`, `C:\work\repo`); strings.Contains(other, `\`) {
			t.Errorf("on another drive it is %q", other)
		}
	}
}
