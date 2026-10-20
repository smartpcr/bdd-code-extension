// Three runs in both formats, canonicalised against what the corpus stores.

package conformance

import (
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/report"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/where"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/exec"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/schema"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/trace"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

func TestThreeRunsInBothFormatsCanonicaliseToWhatIsStored(t *testing.T) {
	corpus, err := Find()
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := corpus.Manifest()
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := schema.Load(corpus.Schema())
	if err != nil {
		t.Fatal(err)
	}
	reports, ok := walk.AsMap(manifest.Value("reports"))
	if !ok {
		t.Fatal("the manifest declares no reports")
	}
	entries, _ := walk.List(reports, "entries")

	failures := []string{}
	checked := 0
	pending := []string{}
	for _, raw := range entries {
		entry, ok := walk.AsMap(raw)
		if !ok {
			continue
		}
		name := walk.Text(entry, "suite")
		// A pending entry is neither run nor counted as passed
		// (conformance/README.md).
		if PendingIn(entry, "go") {
			pending = append(pending, name)
			continue
		}
		path := corpus.Path(name)
		text, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		document, err := model.Load(string(text))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		held, _ := document.Value.(*model.Map)

		options := &exec.Options{}
		if tags := walk.Text(entry, "tags"); tags != "" {
			options.Tags = strings.Split(tags, ",")
		}
		recorded := &trace.Trace{}
		composite := where.CorpusComposite()
		run := &exec.RunExtensions{Composite: composite, Started: extension.Start(composite, nil)}
		result, err := exec.RunFile(path, held, loaded, options, run, recorded)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		suites := []exec.SuiteResult{result}
		format := walk.Text(entry, "format")
		produced := report.NUnit3(suites)
		if format == "JUnit" {
			produced = report.JUnit(suites)
		}
		storedText, err := os.ReadFile(corpus.Path(walk.Text(entry, "expected")))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		stored := strings.ReplaceAll(string(storedText), "\r\n", "\n")
		checked++
		canonical := canonicalise(t, produced)
		if canonical == stored {
			continue
		}
		producedLines := strings.Split(canonical, "\n")
		storedLines := strings.Split(stored, "\n")
		first := 0
		for index := range max(len(producedLines), len(storedLines)) {
			if at(producedLines, index) != at(storedLines, index) {
				first = index
				break
			}
		}
		failures = append(failures, fmt.Sprintf(
			"%s in %s differs at line %d:\n  produced: %s\n  stored:   %s",
			name, format, first+1, at(producedLines, first), at(storedLines, first)))
	}

	t.Logf("%d of %d stored reports match; pending for go: %v", checked-len(failures), checked, pending)
	if checked+len(pending) != 7 {
		t.Fatalf("%d reports were checked and %d are pending, not 7 in all", checked, len(pending))
	}
	if len(failures) > 0 {
		t.Fatal(strings.Join(failures, "\n"))
	}
}

func at(lines []string, index int) string {
	if index < len(lines) {
		return lines[index]
	}
	return "(nothing)"
}
