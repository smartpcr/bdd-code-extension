// The execute corpus: the trace a run must emit, and the code it must exit
// with.
//
// A report says which cases passed; only a trace says in which order the phases
// ran, which step a guard skipped and which row of a table failed.

package conformance

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/where"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/cli"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/run"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/value"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

// asLines is one trace as one comparable line per entry.
func asLines(entries []any) []string {
	out := make([]string, 0, len(entries))
	for _, raw := range entries {
		entry, ok := walk.AsMap(raw)
		if !ok {
			continue
		}
		out = append(out, fmt.Sprintf("%s | %s | %s | %s | %s | %s",
			walk.Text(entry, "phase"),
			walk.Text(entry, "case"),
			walk.Text(entry, "step"),
			walk.Text(entry, "action"),
			walk.Text(entry, "status"),
			walk.Text(entry, "reason")))
	}
	return out
}

func TestEveryExecuteEntry(t *testing.T) {
	corpus, err := Find()
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := corpus.Manifest()
	if err != nil {
		t.Fatal(err)
	}
	scratch := t.TempDir()

	failures := []string{}
	checked := 0
	pending := []string{}
	for _, entry := range Entries(manifest, "execute") {
		name := walk.Text(entry, "suite")
		if PendingIn(entry, "go") {
			pending = append(pending, name)
			continue
		}
		stem := strings.TrimSuffix(filepath.Base(name), ".yml")
		tracePath := filepath.Join(scratch, stem+".trace.json")
		schemaRoot := corpus.Schema()
		if root := walk.Text(entry, "schemaRoot"); root != "" {
			schemaRoot = corpus.Path(root)
		}
		line := []string{"run", "--schema-root", schemaRoot, "--path", corpus.Path(name), "--trace-file", tracePath}
		if names := walk.Text(entry, "names"); names != "" {
			line = append(line, "--name", names)
		}
		transcript := walk.Text(entry, "progress")
		if transcript != "" {
			line = append(line, "--progress")
		}
		if tags := walk.Text(entry, "tags"); tags != "" {
			line = append(line, "--tags", tags)
		}
		if params, ok := walk.AsMap(entry.Value("params")); ok {
			for _, given := range params.Keys() {
				line = append(line, "--param", given+"="+value.Text(params.Value(given)))
			}
		}
		composite := where.CorpusComposite()
		options, err := cli.Parse(line, composite.Options...)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}

		printed := &strings.Builder{}
		standard := run.ProgressWriter
		run.ProgressWriter = printed
		started := time.Now()
		report := run.Execute(options, composite)
		seconds := time.Since(started).Seconds()
		run.ProgressWriter = standard
		checked++

		lines := strings.FieldsFunc(printed.String(), func(r rune) bool { return r == '\n' || r == '\r' })
		if transcript != "" {
			wanted, err := os.ReadFile(corpus.Path(transcript))
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			expected := strings.FieldsFunc(string(wanted), func(r rune) bool { return r == '\n' || r == '\r' })
			if got := maskProgress(lines); strings.Join(got, "\n") != strings.Join(expected, "\n") {
				failures = append(failures, fmt.Sprintf("%s progress differs.\nPrinted:\n  %s\nExpected:\n  %s",
					name, strings.Join(got, "\n  "), strings.Join(expected, "\n  ")))
			}
		} else if len(lines) > 0 {
			failures = append(failures, name+" printed progress lines without --progress")
		}

		expectation, err := corpus.JSON(walk.Text(entry, "expectation"))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		expectedCode := int64(0)
		if given, ok := expectation.Value("exitCode").(int64); ok {
			expectedCode = given
		}
		if int64(report.Code) != expectedCode {
			failures = append(failures, fmt.Sprintf(
				"%s exits %d; the expectation says %d. It said:\n%s\n%s",
				name, report.Code, expectedCode, report.Out, report.Errors))
			continue
		}
		if most, ok := value.AsNumber(expectation.Value("maxSeconds")); ok && most > 0 {
			if seconds >= most {
				failures = append(failures, fmt.Sprintf(
					"%s took %.1fs; it has to finish inside %vs or the limit was waited out", name, seconds, most))
			}
		}
		text, err := os.ReadFile(tracePath)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s wrote no trace: %v", name, err))
			continue
		}
		var raw []any
		if err := json.Unmarshal(text, &raw); err != nil {
			failures = append(failures, fmt.Sprintf("%s wrote a trace that is not JSON: %v", name, err))
			continue
		}
		produced := asLines(ordered(raw).([]any))
		expected := asLines(listOf(expectation, "trace"))
		if strings.Join(produced, "\n") != strings.Join(expected, "\n") {
			failures = append(failures, fmt.Sprintf(
				"%s trace differs.\nProduced:\n  %s\nExpected:\n  %s",
				name, strings.Join(produced, "\n  "), strings.Join(expected, "\n  ")))
		}
	}

	t.Logf("%d of %d execute entries match; pending for go: %v", checked-len(failures), checked, pending)
	if checked < 9 {
		t.Fatalf("only %d entries were checked", checked)
	}
	if len(failures) > 0 {
		t.Fatalf("%d of %d entries differ:\n%s", len(failures), checked, strings.Join(failures, "\n"))
	}
}

// maskProgress masks what the progress contract leaves free: the failure text
// and the durations (spec/progress.md).
func maskProgress(lines []string) []string {
	failure := regexp.MustCompile(`^(    failure: ).*$`)
	duration := regexp.MustCompile(`\(\d+s\)`)
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		out = append(out, duration.ReplaceAllString(failure.ReplaceAllString(line, "${1}*"), "(*s)"))
	}
	return out
}

// TestEveryListEntry runs suiterun list with each lists entry's names and tags
// and compares the case names it prints, in order.
func TestEveryListEntry(t *testing.T) {
	corpus, err := Find()
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := corpus.Manifest()
	if err != nil {
		t.Fatal(err)
	}
	items, _ := walk.List(manifest, "lists")
	checked, pending := 0, []string{}
	for _, raw := range items {
		entry, ok := raw.(*model.Map)
		if !ok {
			continue
		}
		if PendingIn(entry, "go") {
			pending = append(pending, walk.Text(entry, "suite"))
			continue
		}
		line := []string{"list", "--schema-root", corpus.Schema(), "--path", corpus.Path(walk.Text(entry, "suite"))}
		for flag, key := range map[string]string{"--name": "names", "--tags": "tags"} {
			if given := walk.Text(entry, key); given != "" {
				line = append(line, flag, given)
			}
		}
		composite := where.CorpusComposite()
		options, err := cli.Parse(line, composite.Options...)
		if err != nil {
			t.Fatal(err)
		}
		report := run.Execute(options, composite)
		listed := []string{}
		for _, row := range strings.Split(report.Out, "\n") {
			if at := strings.Index(row, "  "); at >= 0 {
				listed = append(listed, strings.TrimSpace(row[at+2:]))
			}
		}
		expected := []string{}
		for _, name := range listOf(entry, "expected") {
			expected = append(expected, value.Text(name))
		}
		if report.Code != cli.ExitPassed || strings.Join(listed, ",") != strings.Join(expected, ",") {
			t.Errorf("%s: exit %d, listed %v, expected %v", walk.Text(entry, "suite"), report.Code, listed, expected)
		}
		checked++
	}
	t.Logf("%d list entries match; pending for go: %v", checked, pending)
	if checked != 2 {
		t.Errorf("%d list entries checked, not 2", checked)
	}
}

func listOf(held *model.Map, key string) []any {
	items, _ := walk.List(held, key)
	return items
}
