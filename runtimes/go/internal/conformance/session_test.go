package conformance

import (
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/where"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/exec"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/schema"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/trace"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/value"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

func traceLine(phase, caseName, step, action, status, reason string) string {
	return strings.Join([]string{phase, caseName, step, action, status, reason}, " | ")
}

// expectedLines is an expectation's trace as lines.
func expectedLines(entries []any) []string {
	out := []string{}
	for _, raw := range entries {
		entry, _ := walk.AsMap(raw)
		out = append(out, traceLine(walk.Text(entry, "phase"), walk.Text(entry, "case"), walk.Text(entry, "step"),
			walk.Text(entry, "action"), walk.Text(entry, "status"), walk.Text(entry, "reason")))
	}
	return out
}

// casesReversed is an expectation with its per-case groups in reverse order:
// the suite setup's entries first, the teardown's last.
func casesReversed(entries []any) []string {
	var setup, teardown []string
	type group struct {
		name  string
		lines []string
	}
	var groups []group
	for _, raw := range entries {
		entry, _ := walk.AsMap(raw)
		line := expectedLines([]any{raw})[0]
		switch walk.Text(entry, "phase") {
		case "suite-setup":
			setup = append(setup, line)
		case "suite-teardown":
			teardown = append(teardown, line)
		default:
			name := walk.Text(entry, "case")
			if len(groups) == 0 || groups[len(groups)-1].name != name {
				groups = append(groups, group{name: name})
			}
			groups[len(groups)-1].lines = append(groups[len(groups)-1].lines, line)
		}
	}
	out := append([]string{}, setup...)
	for index := len(groups) - 1; index >= 0; index-- {
		out = append(out, groups[index].lines...)
	}
	return append(out, teardown...)
}

// E1 for Go (docs/test-providers/design.md): every execute entry, driven
// through the session as a test framework drives it (the class hook's setup,
// each case, the class hook's teardown), emits the expected trace in file
// order and, with the cases reversed, the expectation with each case's entries
// moved as a group; and the case results equal the whole-file run's.
func TestE1EveryExecuteEntryThroughTheSessionInFileOrderAndReversed(t *testing.T) {
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
	composite, err := extension.Compose(where.CorpusExtension)
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, entry := range Entries(manifest, "execute") {
		if PendingIn(entry, "go") {
			continue
		}
		name := walk.Text(entry, "suite")
		suiteModel, err := corpus.YAML(name)
		if err != nil {
			t.Fatal(err)
		}
		expectation, err := corpus.JSON(walk.Text(entry, "expectation"))
		if err != nil {
			t.Fatal(err)
		}
		wanted, _ := walk.List(expectation, "trace")
		options := &exec.Options{}
		for _, tag := range strings.Split(walk.Text(entry, "tags"), ",") {
			if tag = strings.TrimSpace(tag); tag != "" {
				options.Tags = append(options.Tags, tag)
			}
		}
		if params, ok := walk.AsMap(entry.Value("params")); ok {
			for _, key := range params.Keys() {
				options.Params = append(options.Params, [2]string{key, value.Text(params.Value(key))})
			}
		}

		drive := func(reversed bool) ([]string, []exec.CaseResult) {
			run := &exec.RunExtensions{Composite: composite, Started: extension.Start(composite, nil)}
			context := exec.ForRun(options, run, &trace.Trace{})
			session, err := exec.Open(corpus.Path(name), suiteModel, loaded, context, false)
			if err != nil {
				t.Fatal(err)
			}
			session.Setup()
			order := make([]int, len(session.Cases))
			for index := range order {
				order[index] = index
			}
			if reversed {
				sort.Sort(sort.Reverse(sort.IntSlice(order)))
			}
			var results []exec.CaseResult
			for _, index := range order {
				if err := session.BeforeEach(index); err != nil {
					t.Fatal(err)
				}
				if _, err := session.RunCase(index); err != nil {
					t.Fatal(err)
				}
				result, err := session.AfterEach(index)
				if err != nil {
					t.Fatal(err)
				}
				results = append(results, result)
			}
			session.Teardown()
			lines := []string{}
			for _, one := range context.Trace.Snapshot() {
				lines = append(lines, traceLine(string(one.Phase), one.Case, one.Step, one.Action, string(one.Status), string(one.Reason)))
			}
			return lines, results
		}

		inOrder, results := drive(false)
		if got, want := strings.Join(inOrder, "\n"), strings.Join(expectedLines(wanted), "\n"); got != want {
			t.Errorf("%s (file order):\n%s\nexpected:\n%s", name, got, want)
		}
		reversed, _ := drive(true)
		if got, want := strings.Join(reversed, "\n"), strings.Join(casesReversed(wanted), "\n"); got != want {
			t.Errorf("%s (reversed):\n%s\nexpected:\n%s", name, got, want)
		}

		run := &exec.RunExtensions{Composite: composite, Started: extension.Start(composite, nil)}
		whole, err := exec.RunFile(corpus.Path(name), suiteModel, loaded, options, run, &trace.Trace{})
		if err != nil {
			t.Fatal(err)
		}
		var wholeCases, sessionCases []string
		for _, one := range whole.Cases {
			if one.Name != "teardown" {
				wholeCases = append(wholeCases, fmt.Sprintf("%s|%s|%s", one.Name, one.Status, one.Message))
			}
		}
		for _, one := range results {
			sessionCases = append(sessionCases, fmt.Sprintf("%s|%s|%s", one.Name, one.Status, one.Message))
		}
		if strings.Join(wholeCases, "\n") != strings.Join(sessionCases, "\n") {
			t.Errorf("%s: results differ from the whole-file run:\n%s\nvs\n%s", name, strings.Join(sessionCases, "\n"), strings.Join(wholeCases, "\n"))
		}
		checked++
	}
	if checked != 14 {
		t.Errorf("%d entries checked, not 14", checked)
	}
}
