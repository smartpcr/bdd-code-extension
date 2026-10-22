package run

// The name filter, run progress and its observer, the action worker and the
// embedded core (docs/packages, D3; spec/progress.md): the parts the corpus
// does not reach.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/suite"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/where"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/cli"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/exec"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/schema"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/trace"
)

func TestNameAndProgressAreReadAndNamedInTheUsage(t *testing.T) {
	parsed, err := cli.Parse([]string{"run", "--path", "x.yml", "--name", " place-* , order-? ,", "--name", "third", "--progress"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(parsed.Names, "|") != "place-*|order-?|third" || !parsed.Progress {
		t.Errorf("parsed %v, progress %v", parsed.Names, parsed.Progress)
	}
	if !strings.Contains(cli.Usage, "[--name a*,b?]") || !strings.Contains(cli.Usage, "[--progress]") {
		t.Errorf("the usage is:\n%s", cli.Usage)
	}
}

func TestANameMatchesAGlobOverTheWholeName(t *testing.T) {
	for _, row := range []struct {
		name, glob string
		matches    bool
	}{
		{"place-an-order", "*-an-order", true}, {"order-1", "order-?", true}, {"order-22", "order-?", false},
		{"read-the-stock", "*-an-order", false}, {"Place-an-order", "place-*", false},
	} {
		if suite.NameMatches(row.name, []string{row.glob}) != row.matches {
			t.Errorf("%s against %s", row.name, row.glob)
		}
	}
	if !suite.NameMatches("anything", nil) {
		t.Error("no filter selects every case")
	}
}

func TestATraceTellsItsCallbackEveryEntryInOrderAndHandsBackTheOneBefore(t *testing.T) {
	recorded := &trace.Trace{}
	seen := []string{}
	if previous := recorded.OnAdded(func(entry trace.Entry) { seen = append(seen, entry.Step) }); previous != nil {
		t.Error("a new trace tells nobody")
	}
	recorded.Add(trace.Step, "a", "first", "core.noop", trace.Passed, "")
	recorded.Add(trace.Step, "a", "second", "core.noop", trace.Passed, "")
	if strings.Join(seen, ",") != "first,second" || len(recorded.Entries) != 2 {
		t.Errorf("seen %v", seen)
	}
	if recorded.OnAdded(nil) == nil {
		t.Error("the callback set is handed back")
	}
}

type recorder struct{ heard []string }

func (held *recorder) CaseStarted(suiteName, caseName string) {
	held.heard = append(held.heard, "start "+suiteName+"::"+caseName)
}
func (held *recorder) CaseFinished(suiteName string, result exec.CaseResult) {
	held.heard = append(held.heard, "end "+suiteName+"::"+result.Name+" "+string(result.Status))
}
func (held *recorder) Entry(entry trace.Entry) {
	held.heard = append(held.heard, "entry "+string(entry.Phase)+" "+entry.Case)
}

// runFile runs one corpus suite the whole-file way.
func runFile(t *testing.T, relative string, options *exec.Options, recorded *trace.Trace) exec.SuiteResult {
	t.Helper()
	held, err := loadSuite(corpus(t, relative))
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := schema.Load(where.CorpusSchema())
	if err != nil {
		t.Fatal(err)
	}
	composite := where.CorpusComposite()
	result, err := exec.RunFile(corpus(t, relative), held, loaded, options,
		&exec.RunExtensions{Composite: composite, Started: extension.Start(composite, nil)}, recorded)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestAnObserverHearsSelectedCasesOnlyAndNeverChangesTheTrace(t *testing.T) {
	plain, observed := &trace.Trace{}, &trace.Trace{}
	runFile(t, "execute/names-and-tags.yml", &exec.Options{Tags: []string{"wanted"}, Names: []string{"*-order"}}, plain)
	heard := &recorder{}
	runFile(t, "execute/names-and-tags.yml", &exec.Options{Tags: []string{"wanted"}, Names: []string{"*-order"}, Observer: heard}, observed)
	a, _ := json.Marshal(plain.JSON())
	b, _ := json.Marshal(observed.JSON())
	if string(a) != string(b) {
		t.Errorf("the observer changed the trace:\n%s\n%s", a, b)
	}
	want := "start names-and-tags::a-wanted-order|entry step a-wanted-order|entry case a-wanted-order|" +
		"end names-and-tags::a-wanted-order passed|entry case an-unwanted-order|entry case a-wanted-refund"
	if got := strings.Join(heard.heard, "|"); got != want {
		t.Errorf("it heard:\n%s", got)
	}
	if observed.OnAdded(nil) != nil {
		t.Error("the observer is left attached after the file")
	}
}

func TestADryRunTellsTheObserverNothing(t *testing.T) {
	heard := &recorder{}
	runFile(t, "execute/hooks.yml", &exec.Options{DryRun: true, Observer: heard}, &trace.Trace{})
	if len(heard.heard) != 0 {
		t.Errorf("it heard %v", heard.heard)
	}
}

func TestTheProgressPrinterWritesTheSpecifiedShape(t *testing.T) {
	printed := &strings.Builder{}
	printer := NewProgressPrinter(printed)
	printer.Entry(trace.Entry{Phase: trace.SuiteSetup, Step: "step 1 (core.record)", Action: "core.record", Status: trace.Passed})
	printer.CaseStarted("orders", "place")
	printer.Entry(trace.Entry{Phase: trace.Step, Case: "place", Step: "the order", Action: "shop.order", Status: trace.Failed, Reason: trace.Action})
	printer.Entry(trace.Entry{Phase: trace.Case, Case: "place", Status: trace.Failed, Reason: trace.Action})
	printer.CaseFinished("orders", exec.CaseResult{Name: "place", Status: trace.Failed, Message: "two\r\nlines", DurationSec: 2.6})
	printer.CaseFinished("orders", exec.CaseResult{Name: "later", Status: trace.Skipped})
	printer.CaseFinished("orders", exec.CaseResult{Name: "ok", Status: trace.Passed, DurationSec: 0.5})
	printer.CaseFinished("orders", exec.CaseResult{Name: "silent", Status: trace.Error})
	printer.Summary()
	want := strings.Join([]string{
		"    suite-setup   step 1 (core.record) passed",
		"StartGroup: orders::place",
		"    step          the order (shop.order) failed [action]",
		"    failure: two lines",
		"EndGroup: orders::place [Failed] (3s)",
		"EndGroup: orders::later [Skipped] (0s)",
		"EndGroup: orders::ok [Passed] (1s)",
		"EndGroup: orders::silent [Failed] (0s)",
		"Summary: Total=4, Passed=1, Failed=2, Blocked=0, Not Run=0, Skipped=1",
	}, "\n") + "\n"
	if printed.String() != want {
		t.Errorf("it printed:\n%s", printed.String())
	}
}

func TestByDefaultProgressGoesToStandardOutput(t *testing.T) {
	if ProgressWriter != os.Stdout {
		t.Error("progress is not on standard output")
	}
}

func TestARunWithoutProgressPrintsNothingAndOneWithItSummarisesEveryFile(t *testing.T) {
	printed := &strings.Builder{}
	standard := ProgressWriter
	ProgressWriter = printed
	defer func() { ProgressWriter = standard }()

	if report := corpusExecute(options(t, "run --path "+corpus(t, "execute/hooks.yml"))); report.Code != cli.ExitPassed || printed.Len() != 0 {
		t.Fatalf("exit %d, printed %q", report.Code, printed.String())
	}
	// Three files in sorted order; the filter selects nothing in the first.
	report := corpusExecute(options(t, "run --progress --name first,*-an-order --path "+corpus(t, "execute/names*.yml")))
	lines := strings.Split(strings.TrimSpace(printed.String()), "\n")
	groups := []string{}
	for _, line := range lines {
		if strings.HasPrefix(line, "StartGroup: ") {
			groups = append(groups, strings.TrimPrefix(line, "StartGroup: "))
		}
	}
	if report.Code != cli.ExitPassed || strings.Join(groups, ",") != "names-none::first,names::place-an-order,names::cancel-an-order" ||
		lines[len(lines)-1] != "Summary: Total=3, Passed=3, Failed=0, Blocked=0, Not Run=0, Skipped=0" {
		t.Errorf("exit %d, printed:\n%s", report.Code, printed.String())
	}
}

func TestACaseWhoseActionPanicsFailsAndTheRunCarriesOn(t *testing.T) {
	recorded := &trace.Trace{}
	result := runFile(t, "execute/worker-throws.yml", &exec.Options{}, recorded)
	got := []string{}
	for _, one := range result.Cases {
		got = append(got, one.Name+"|"+string(one.Status)+"|"+string(one.Reason))
	}
	if strings.Join(got, ",") != "the-case-whose-action-throws|failed|action,the-case-after-it|passed|" {
		t.Errorf("results %v", got)
	}
	if !strings.Contains(result.Cases[0].Message, "thrown on purpose") {
		t.Errorf("message %q", result.Cases[0].Message)
	}
	last := recorded.Entries[len(recorded.Entries)-1]
	if last.Phase != trace.SuiteTeardown || last.Status != trace.Passed {
		t.Errorf("the teardown did not run: %+v", last)
	}
}

func TestTheEmbeddedCoreIsTheSpecsAndBddSuiteCoreCutsItsBindings(t *testing.T) {
	spec, err := os.ReadFile(filepath.Join(where.Repo(), "spec", "core.catalog.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	normal := func(text string) string { return strings.ReplaceAll(text, "\r\n", "\n") }
	if normal(schema.CoreCatalogText()) != normal(string(spec)) {
		t.Error("suite/schema/core.catalog.yaml differs from spec/core.catalog.yaml: copy the spec's again")
	}
	cut, err := schema.Load(corpus(t, "schema-core-import"))
	if err != nil {
		t.Fatal(err)
	}
	whole, err := schema.Load(where.CorpusSchema())
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"core.noop", "core.set", "core.fail", "core.skip", "core.sleep", "core.record", "wait"} {
		if strings.Join(cut.Actions[name].Bindings, ",") != "csharp" ||
			strings.Join(whole.Actions[name].Bindings, ",") != "powershell,csharp,go,rust,typescript" {
			t.Errorf("%s: cut %v, whole %v", name, cut.Actions[name].Bindings, whole.Actions[name].Bindings)
		}
	}
	if len(cut.Actions) != 7 {
		t.Errorf("%d actions through bdd-suite:core", len(cut.Actions))
	}
}

func TestBddSuiteCoreIsReadWholeWhenTheImporterListsNoBindings(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "actions.catalog.yaml"), []byte("catalogVersion: 1\nimports: [ 'bdd-suite:core' ]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	text, err := os.ReadFile(corpus(t, "schema-core-import/suite.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "suite.schema.json"), text, 0o644); err != nil {
		t.Fatal(err)
	}
	loaded, err := schema.Load(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Actions["wait"].Bindings) != 5 {
		t.Errorf("wait's bindings: %v", loaded.Actions["wait"].Bindings)
	}
}
