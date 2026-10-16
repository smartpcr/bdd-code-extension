package exec

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/where"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/actions"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/schema"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/trace"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

// The execute corpus in conformance/ is what says this executor behaves the
// way the other runtimes do. What is here is the rest: the pieces a shared
// corpus cannot reach, and the ones about Go rather than about the format.

func bagWith(t *testing.T, text string) *Context {
	t.Helper()
	document, err := model.Load(text)
	if err != nil {
		t.Fatal(err)
	}
	scope := model.NewMap()
	scope.Set("capture", document.Value)
	return &Context{Scope: scope}
}

func TestASubjectWalksIntoTheBagAndSaysWhetherItWasThere(t *testing.T) {
	held := bagWith(t, "cs:\n  State: Up\n  Nodes: [N1, N2]\nnothing:\n")
	for _, row := range []struct {
		path    string
		want    any
		present bool
	}{
		{"cs.State", "Up", true},
		{"cs.Nodes.1", "N2", true},
		{"cs.Nodes.9", nil, false},
		{"cs.Missing", nil, false},
		{"nothing", nil, true},
		{"nothing.deeper", nil, false},
	} {
		got, present := actualValue(row.path, held)
		if present != row.present || (present && got != row.want) {
			t.Errorf("%s is %v, %v; wanted %v, %v", row.path, got, present, row.want, row.present)
		}
	}
	if _, present := actualValue("anything", &Context{Scope: model.NewMap()}); present {
		t.Error("a bag that is not there resolved")
	}
}

func TestAScriptAssertionIsRefusedRatherThanPassed(t *testing.T) {
	held := bagWith(t, "cs:\n  State: Up\n")
	assertion := model.NewMap()
	assertion.Set("script", "$true")
	err := checkAssertion(assertion, held)
	if err == nil || !strings.Contains(err.Error(), "PowerShell binding only") {
		t.Errorf("it said %v", err)
	}
}

func TestAnAssertionComparesEveryOperatorItCarries(t *testing.T) {
	held := bagWith(t, "cs:\n  State: Up\n  Count: 3\n")
	passing := model.NewMap()
	passing.Set("var", "cs.State")
	passing.Set("equals", "Up")
	passing.Set("notEquals", "Down")
	if err := checkAssertion(passing, held); err != nil {
		t.Errorf("a passing assertion said %v", err)
	}
	failing := model.NewMap()
	failing.Set("var", "cs.State")
	failing.Set("equals", "Down")
	err := checkAssertion(failing, held)
	if err == nil || !strings.Contains(err.Error(), "expected cs.State equals 'Down'") {
		t.Errorf("it said %v", err)
	}
	refused := model.NewMap()
	refused.Set("var", "cs.State")
	refused.Set("gt", "x")
	if err := checkAssertion(refused, held); err == nil {
		t.Error("an uncomparable pair compared")
	}
	// Something that is not a mapping is nothing to assert, not a failure.
	if err := checkAssertion("not an assertion", held); err != nil {
		t.Errorf("a scalar assertion said %v", err)
	}
	// A reference that resolves to nothing stops the assertion.
	broken := model.NewMap()
	broken.Set("var", "cs.State")
	broken.Set("equals", "${nosuch.thing}")
	if err := checkAssertion(broken, held); err == nil {
		t.Error("an assertion naming nothing was compared")
	}
}

// started composes extensions and starts them with option values, as a run
// does.
func started(t *testing.T, values map[string]string, extensions ...extension.Extension) *RunExtensions {
	t.Helper()
	composite, err := extension.Compose(extensions...)
	if err != nil {
		t.Fatal(err)
	}
	return &RunExtensions{Composite: composite, Started: extension.Start(composite, values)}
}

// slowExtension registers an action that ignores its deadline, which is what
// proves the executor abandons one rather than waiting it out.
func slowExtension(finished chan struct{}) extension.Extension {
	return extension.Extension{
		Name: "slow",
		Actions: []actions.Registration{{Name: "slow.get", Handler: func(*actions.Request) (any, error) {
			time.Sleep(1500 * time.Millisecond)
			close(finished)
			return "too late", nil
		}}},
	}
}

func TestAnActionThatIgnoresItsDeadlineIsAbandoned(t *testing.T) {
	finished := make(chan struct{})
	held := &Context{Scope: model.NewMap(), Run: started(t, nil, slowExtension(finished))}
	step := model.NewMap()
	started := time.Now()
	_, err := bounded("slow.get", step, held, 1, "the step", false)
	elapsed := time.Since(started)
	if err == nil {
		t.Fatal("an overrunning action was waited for")
	}
	if !strings.Contains(err.Error(), "abandoned") {
		t.Errorf("an uninterruptible action said %q", err)
	}
	if elapsed > 3*time.Second {
		t.Errorf("it waited %v", elapsed)
	}
	// The abandoned goroutine finishes on its own rather than leaking a blocked
	// send.
	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		t.Error("the abandoned action never finished")
	}
}

func TestAnInterruptibleActionSaysItWasCancelled(t *testing.T) {
	held := &Context{Scope: model.NewMap()}
	step := model.NewMap()
	step.Set("seconds", int64(30))
	_, err := bounded("core.sleep", step, held, 1, "the step", true)
	if err == nil {
		t.Fatal("a long sleep finished inside its limit")
	}
	if strings.Contains(err.Error(), "abandoned") {
		t.Errorf("an interruptible action said %q", err)
	}
}

func TestAnActionNobodyImplementsIsNamedRatherThanGuessed(t *testing.T) {
	held := &Context{Scope: model.NewMap()}
	_, err := bounded("nosuch.action", model.NewMap(), held, 5, "the step", true)
	if err == nil || err.Error() != "Unknown action: nosuch.action. No extension of this runtime registers it." {
		t.Errorf("it said %v", err)
	}
	// The core has no product prefixes: an action that only an extension
	// registers is unknown in the same words whatever it is called.
	_, err = bounded("slow.get", model.NewMap(), held, 5, "the step", true)
	if err == nil || !strings.Contains(err.Error(), "No extension of this runtime registers it") {
		t.Errorf("it said %v", err)
	}
	// A limit that has already run out is a timeout before anything runs.
	_, err = bounded("core.noop", model.NewMap(), held, 0, "the step", true)
	if err == nil || !strings.Contains(err.Error(), "no time left") {
		t.Errorf("it said %v", err)
	}
	if failure := (&actions.Error{}); !errors.As(err, &failure) {
		t.Error("the refusal is not an action failure")
	}
}

func TestACaseCannotWriteIntoTheSuiteBag(t *testing.T) {
	suiteScope := model.NewMap()
	bag := model.NewMap()
	bag.Set("fromSetup", "kept")
	suiteScope.Set("capture", bag)
	suiteScope.Set("var", model.NewMap())

	copied := cloneScope(suiteScope)
	held := &Context{Scope: copied}
	held.capture("fromCase", "new")
	if !held.has("fromSetup") || !held.has("fromCase") {
		t.Error("the case cannot see what the setup left")
	}
	original, _ := walk.AsMap(suiteScope.Value("capture"))
	if original.Has("fromCase") {
		t.Error("the case wrote into the suite bag")
	}
}

func TestABaseNameIsWhatTheFileIsCalledWithoutItsExtension(t *testing.T) {
	for _, row := range [][2]string{
		{`C:\work\suites\host.yml`, "host"},
		{"/work/suites/host.yml", "host"},
		{"host.yml", "host"},
		{"host", "host"},
	} {
		if got := baseName(row[0]); got != row[1] {
			t.Errorf("%s is %q, wanted %q", row[0], got, row[1])
		}
	}
}

func TestAllNamesIsTheCoreActionsWaitAndEveryExtensionsActions(t *testing.T) {
	core := AllNames(nil)
	if len(core) != 6 || core[len(core)-1] != "wait" {
		t.Errorf("without an extension the names are %v", core)
	}
	full := AllNames(started(t, nil, slowExtension(nil)).Composite)
	if len(full) != 7 || !containsName(full, "slow.get") {
		t.Errorf("with an extension the names are %v", full)
	}
	for index := 1; index < len(full); index++ {
		if full[index-1] > full[index] {
			t.Error("the names do not come out in one order")
		}
	}
}

func TestARunThatFailedIsWhatDecidesTheExitCode(t *testing.T) {
	passed := &RunResult{Suites: []SuiteResult{{Cases: []CaseResult{{Status: trace.Passed}}}}}
	if Failed(passed) {
		t.Error("a passing run failed")
	}
	skipped := &RunResult{Suites: []SuiteResult{{Cases: []CaseResult{{Status: trace.Skipped}}}}}
	if Failed(skipped) {
		t.Error("a skipped case failed the run")
	}
	for _, status := range []trace.Status{trace.Failed, trace.Error} {
		held := &RunResult{Suites: []SuiteResult{{Cases: []CaseResult{{Status: status}}}}}
		if !Failed(held) {
			t.Errorf("a %s case did not fail the run", status)
		}
	}
	if Failed(&RunResult{}) {
		t.Error("a run of nothing failed")
	}
}

func TestAWaitNeedsSomethingToDo(t *testing.T) {
	loaded := committed(t)
	held := &Context{Scope: model.NewMap()}
	recorded := &trace.Trace{}
	_, err := wait(model.NewMap(), held, loaded, time.Now().Add(time.Second),
		trace.Step, "c", recorded)
	if err == nil || !strings.Contains(err.Error(), "seconds, or a forStep") {
		t.Errorf("it said %v", err)
	}
	// A plain sleep is what a wait with only seconds does.
	step := model.NewMap()
	step.Set("seconds", 0.01)
	produced, err := wait(step, held, loaded, time.Now().Add(time.Second), trace.Step, "c", recorded)
	if err != nil {
		t.Fatal(err)
	}
	waited, _ := walk.AsMap(produced)
	if waited.Value("waitedSec") != 0.01 {
		t.Errorf("it waited %v", produced)
	}
}

func TestAWaitGivesUpWhenTheStepItPollsNeverSatisfiesItsUntil(t *testing.T) {
	loaded := committed(t)
	held := &Context{Scope: model.NewMap()}
	document, err := model.Load(`
action: wait
intervalSec: 1
timeoutSec: 1
forStep:
  action: core.set
  value: still working
  captureAs: state
until:
  var: state
  equals: done
`)
	if err != nil {
		t.Fatal(err)
	}
	step, _ := document.Value.(*model.Map)
	_, err = wait(step, held, loaded, time.Now().Add(10*time.Second), trace.Step, "c", &trace.Trace{})
	if err == nil || !strings.Contains(err.Error(), "never satisfied its until") {
		t.Errorf("it said %v", err)
	}
}

func containsName(names []string, wanted string) bool {
	for _, name := range names {
		if name == wanted {
			return true
		}
	}
	return false
}

// committed is the corpus's schema (its catalog imports the core).
func committed(t *testing.T) *schema.Schema {
	t.Helper()
	loaded, err := schema.Load(where.CorpusSchema())
	if err != nil {
		t.Fatal(err)
	}
	return loaded
}

func TestARecordPathReachesTheActionThatWritesIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "markers.txt")
	held := &Context{Scope: model.NewMap(), RecordPath: path}
	step := model.NewMap()
	step.Set("marker", "here")
	if _, err := bounded("core.record", step, held, 5, "the step", true); err != nil {
		t.Fatal(err)
	}
	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(written)) != "here" {
		t.Errorf("the file holds %q", written)
	}
	_ = context.Background()
}

// An extension's action sees the state its extension's Start returned for this
// run, and a core action sees none.
func TestAnExtensionsActionReceivesItsOwnState(t *testing.T) {
	seen := make(chan any, 1)
	probe := extension.Extension{
		Name:    "probe",
		Options: []extension.Option{{Flag: "--probe", Description: "A value."}},
		Actions: []actions.Registration{{Name: "probe.read", Handler: func(request *actions.Request) (any, error) {
			seen <- request.State
			return nil, nil
		}}},
		Start: func(options map[string]string) extension.RunState {
			return extension.RunState{State: "state:" + options["--probe"]}
		},
	}
	held := &Context{Scope: model.NewMap(), Run: started(t, map[string]string{"--probe": "x", "--other": "y"}, probe)}
	if _, err := bounded("probe.read", model.NewMap(), held, 5, "the step", true); err != nil {
		t.Fatal(err)
	}
	if got := <-seen; got != "state:x" {
		t.Errorf("the action saw %v", got)
	}
}

// runSuite runs one suite text through RunFile with the given extensions.
func runSuite(t *testing.T, text string, run *RunExtensions) (SuiteResult, []string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "probe.yml")
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	document, err := model.Load(text)
	if err != nil {
		t.Fatal(err)
	}
	held, _ := document.Value.(*model.Map)
	recorded := &trace.Trace{}
	result, err := RunFile(path, held, committed(t), &Options{}, run, recorded)
	if err != nil {
		t.Fatal(err)
	}
	outputs := []string{}
	for _, one := range result.Cases {
		outputs = append(outputs, strings.TrimSpace(one.Output))
	}
	return result, outputs
}

// The extensions' context keys: a value given for this run wins over the
// suite's defaults; the defaults are read when no value is given; a declared
// key with neither reads as "". Without the extension the key is no root.
func TestAContextKeyReadsTheRunsValueThenTheDefaultsThenNothing(t *testing.T) {
	keys := extension.Extension{
		Name:        "keys",
		ContextKeys: []string{"given", "defaulted", "absent"},
		Start: func(map[string]string) extension.RunState {
			return extension.RunState{Context: map[string]any{"given": "from the run", "undeclared": "ignored"}}
		},
	}
	suite := `
suite: keys
defaults:
  given: from the defaults
  defaulted: from the defaults
tests:
  - name: reads
    steps:
      - action: core.set
        value: "${given}|${defaulted}|[${absent}]"
`
	result, outputs := runSuite(t, suite, started(t, nil, keys))
	if result.Cases[0].Status != trace.Passed {
		t.Fatalf("the case %s: %s", result.Cases[0].Status, result.Cases[0].Message)
	}
	if outputs[0] != `"from the run|from the defaults|[]"` {
		t.Errorf("the values read are %s", outputs[0])
	}
	without, _ := runSuite(t, strings.Replace(suite, "|[${absent}]", "", 1), CoreOnly())
	if without.Cases[0].Status != trace.Failed {
		t.Errorf("without the extension the case %s", without.Cases[0].Status)
	}
}

// A rule's case limit caps what a case declares; it never raises it.
func TestAnExtensionsCaseLimitCapsTheCase(t *testing.T) {
	ceiling := extension.Extension{
		Name: "ceiling",
		// Two seconds, not one: a step gets the whole seconds the case has
		// left, and one second less any time already spent is none.
		Rules: extension.Rules{CaseLimitSec: func(suite *model.Map, declared int64) int64 {
			return 2
		}},
	}
	suite := `
suite: capped
tests:
  - name: sleeps
    timeoutSec: 30
    steps:
      - action: core.sleep
        seconds: 5
`
	began := time.Now()
	result, _ := runSuite(t, suite, started(t, nil, ceiling))
	// 1s or 2s, by how much of the first second has gone: either is the cap.
	if result.Cases[0].Status != trace.Failed || !regexp.MustCompile(`exceeded its [12]s limit`).MatchString(result.Cases[0].Message) {
		t.Errorf("the capped case %s: %s", result.Cases[0].Status, result.Cases[0].Message)
	}
	if time.Since(began) > 4*time.Second {
		t.Errorf("the cap was not applied: %v", time.Since(began))
	}
	raised := extension.Extension{
		Name:  "raised",
		Rules: extension.Rules{CaseLimitSec: func(*model.Map, int64) int64 { return 99999 }},
	}
	if limit := started(t, nil, raised).Composite.CaseLimitSec(model.NewMap(), 30); limit != 30 {
		t.Errorf("a rule raised the limit to %d", limit)
	}
}
