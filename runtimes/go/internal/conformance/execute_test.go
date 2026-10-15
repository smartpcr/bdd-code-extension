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
	for _, entry := range Entries(manifest, "execute") {
		name := walk.Text(entry, "suite")
		stem := strings.TrimSuffix(filepath.Base(name), ".yml")
		tracePath := filepath.Join(scratch, stem+".trace.json")
		line := []string{"run", "--schema-root", corpus.Schema(), "--path", corpus.Path(name), "--trace-file", tracePath}
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

		started := time.Now()
		report := run.Execute(options, composite)
		seconds := time.Since(started).Seconds()
		checked++

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

	t.Logf("%d of %d execute entries match", checked-len(failures), checked)
	if checked < 9 {
		t.Fatalf("only %d entries were checked", checked)
	}
	if len(failures) > 0 {
		t.Fatalf("%d of %d entries differ:\n%s", len(failures), checked, strings.Join(failures, "\n"))
	}
}

func listOf(held *model.Map, key string) []any {
	items, _ := walk.List(held, key)
	return items
}
