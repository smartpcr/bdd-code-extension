package exec

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/actions"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/trace"
)

// The session (spec/session.md), one test per rule. E1, the corpus through the
// session, is in internal/conformance (session_test.go).

const hooks = `suite: hooks
setup:
  - action: core.record
    marker: s
beforeEach:
  - action: core.record
    marker: b
afterEach:
  - action: core.record
    marker: a
teardown:
  - action: core.record
    marker: t
tests:
  - name: one
    tags: [first]
    steps:
      - then: it runs
        action: core.noop
  - name: two
    tags: [second]
    steps:
      - then: it runs too
        action: core.noop
`

func openText(t *testing.T, text string, context *RunContext, guarded bool) *Session {
	t.Helper()
	path := filepath.Join(t.TempDir(), "session.yml")
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	document, err := model.Load(text)
	if err != nil {
		t.Fatal(err)
	}
	held, _ := document.Value.(*model.Map)
	if context == nil {
		context = ForRun(&Options{}, nil, &trace.Trace{})
	}
	session, err := Open(path, held, committed(t), context, guarded)
	if err != nil {
		t.Fatal(err)
	}
	return session
}

func phases(session *Session) []string {
	out := []string{}
	for _, entry := range session.Trace().Snapshot() {
		out = append(out, string(entry.Phase)+":"+entry.Case+":"+string(entry.Status))
	}
	return out
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func runOne(t *testing.T, session *Session, index int) CaseResult {
	t.Helper()
	must(t, session.BeforeEach(index))
	_, err := session.RunCase(index)
	must(t, err)
	result, err := session.AfterEach(index)
	must(t, err)
	return result
}

func count(entries []string, wanted string) int {
	n := 0
	for _, entry := range entries {
		if strings.HasPrefix(entry, wanted) {
			n++
		}
	}
	return n
}

func TestRule2SetupRunsOnceHoweverOftenItIsCalled(t *testing.T) {
	session := openText(t, hooks, nil, false)
	session.Setup()
	session.Setup()
	runOne(t, session, 0)
	if got := count(phases(session), "suite-setup"); got != 1 {
		t.Errorf("setup ran %d times", got)
	}
}

func TestRule2NothingSelectedRunsNeitherSetupNorTeardown(t *testing.T) {
	session := openText(t, hooks, ForRun(&Options{Tags: []string{"nobody"}}, nil, &trace.Trace{}), false)
	session.Setup()
	result := runOne(t, session, 0)
	if result.Status != trace.Skipped || result.Reason != trace.Tag {
		t.Errorf("result %+v", result)
	}
	if session.Teardown().Ran {
		t.Error("teardown ran")
	}
	if got := strings.Join(phases(session), ","); got != "case:one:skipped" {
		t.Errorf("trace %s", got)
	}
}

func TestRule2BeforeEachRunsTheSetupWhenNoClassHookDid(t *testing.T) {
	session := openText(t, hooks, nil, false)
	runOne(t, session, 1)
	if !session.Teardown().Ran {
		t.Error("teardown did not run")
	}
	want := "suite-setup::passed,before-each:two:passed,step:two:passed,after-each:two:passed,case:two:passed,suite-teardown::passed"
	if got := strings.Join(phases(session), ","); got != want {
		t.Errorf("trace %s", got)
	}
}

func TestRule3AFailedSetupIsRecordedAndEveryCaseReportsIt(t *testing.T) {
	session := openText(t, strings.Replace(hooks, "marker: s", "marker: s\n  - action: core.fail\n    message: no precondition", 1), nil, false)
	session.Setup()
	result := runOne(t, session, 0)
	if result.Status != trace.Error || result.Reason != trace.SuiteSetupFail || !strings.HasPrefix(result.Message, "Suite setup failed: ") {
		t.Errorf("result %+v", result)
	}
	if !session.Teardown().Ran {
		t.Error("teardown did not run")
	}
	if count(phases(session), "before-each") != 0 {
		t.Error("beforeEach ran after a failed setup")
	}
}

func TestRule3AFailedBeforeEachIsRecordedAndTheCaseStillCleansUp(t *testing.T) {
	text := strings.Replace(hooks, "marker: b", "marker: b\n  - action: core.fail\n    message: not ready", 1)
	text = strings.Replace(text, "      - then: it runs\n        action: core.noop\n",
		"      - then: it runs\n        action: core.noop\n    cleanup:\n      - action: core.record\n        marker: c\n", 1)
	session := openText(t, text, nil, false)
	result := runOne(t, session, 0)
	got := phases(session)
	if result.Status != trace.Failed || result.Reason != trace.Hook || result.AfterEachFailed {
		t.Errorf("result %+v", result)
	}
	if count(got, "step:one") != 0 || count(got, "case-cleanup:one:passed") != 1 || count(got, "after-each:one:passed") != 1 {
		t.Errorf("trace %v", got)
	}
}

func TestRule4AFailedAfterEachSettlesTheCaseAndSaysSo(t *testing.T) {
	session := openText(t, strings.Replace(hooks, "marker: a", "marker: a\n  - action: core.fail\n    message: could not tidy", 1), nil, false)
	result := runOne(t, session, 0)
	if !result.AfterEachFailed || result.Status != trace.Failed || result.Reason != trace.Hook || !strings.Contains(result.Message, "afterEach failed:") {
		t.Errorf("result %+v", result)
	}
}

func TestRule4AnAfterEachWithoutTheCaseStillCleansUpAndFails(t *testing.T) {
	session := openText(t, hooks, nil, false)
	must(t, session.BeforeEach(0))
	result, err := session.AfterEach(0)
	must(t, err)
	if result.Status != trace.Failed || !strings.Contains(result.Message, "not the case itself") {
		t.Errorf("result %+v", result)
	}
}

func TestRule1OperationsOutOfOrderAreRefused(t *testing.T) {
	session := openText(t, hooks, nil, false)
	if _, err := session.RunCase(0); err == nil {
		t.Error("RunCase before BeforeEach")
	}
	if _, err := session.AfterEach(0); err == nil {
		t.Error("AfterEach before BeforeEach")
	}
	must(t, session.BeforeEach(0))
	_, err := session.RunCase(0)
	must(t, err)
	if _, err := session.RunCase(0); err == nil {
		t.Error("RunCase twice")
	}
	_, err = session.AfterEach(0)
	must(t, err)
	if _, err := session.AfterEach(0); err == nil {
		t.Error("AfterEach twice")
	}
	if _, err := session.IndexOf("three"); err == nil {
		t.Error("a case it does not have")
	}
}

// Rule 5 in Go's terms: a Go slice cannot grow where its other holders see it,
// but a map is shared by reference, so an action that changes a captured map
// in place would reach the next case through a one-level copy.
func TestRule5ACaseThatChangesACapturedMapInPlaceChangesItForItselfOnly(t *testing.T) {
	stamp := extension.Extension{Name: "stamp", Actions: []actions.Registration{{Name: "fixture.append", Handler: func(request *actions.Request) (any, error) {
		held, _ := request.Step.Value("list").(*model.Map)
		held.Set("stamped", true)
		return held, nil
	}}}}
	composite, err := extension.Compose(stamp)
	must(t, err)
	run := &RunExtensions{Composite: composite, Started: extension.Start(composite, nil)}
	text := `suite: maps
setup:
  - action: core.set
    value: { inner: { kept: true } }
    captureAs: shared
tests:
  - name: the-case-that-stamps
    steps:
      - when: it stamps the captured map
        action: fixture.append
        list: ${capture.shared.inner}
        item: x
  - name: the-case-after-it
    steps:
      - then: it does not see the stamp
        action: core.noop
        asserts:
          - var: shared.inner.stamped
            isNull: true
`
	session := openText(t, text, ForRun(&Options{}, run, &trace.Trace{}), false)
	session.Setup()
	runOne(t, session, 0)
	if result := runOne(t, session, 1); result.Status != trace.Passed {
		t.Errorf("the second case saw the first case's change: %+v", result)
	}
}

func TestRule6TeardownRunsOnceAndOnlyAfterASetup(t *testing.T) {
	session := openText(t, hooks, nil, false)
	if session.Teardown().Ran {
		t.Error("teardown before setup")
	}
	session.Setup()
	if !session.Teardown().Ran || session.Teardown().Ran {
		t.Error("teardown not once")
	}
	if got := count(phases(session), "suite-teardown"); got != 1 {
		t.Errorf("teardown traced %d times", got)
	}
}

func TestRule6AFailedTeardownIsReturned(t *testing.T) {
	session := openText(t, strings.Replace(hooks, "marker: t", "marker: t\n  - action: core.fail\n    message: could not undo", 1), nil, false)
	session.Setup()
	result := session.Teardown()
	if !result.Failed || !strings.Contains(result.Message, "could not undo") {
		t.Errorf("result %+v", result)
	}
}

func TestRule7OneCaseOfASessionRunsAtATime(t *testing.T) {
	session := openText(t, hooks, nil, false)
	must(t, session.BeforeEach(0))
	done := make(chan CaseResult)
	go func() {
		must(t, session.BeforeEach(1))
		_, err := session.RunCase(1)
		must(t, err)
		result, err := session.AfterEach(1)
		must(t, err)
		done <- result
	}()
	select {
	case <-done:
		t.Fatal("the second case ran while the first held the lock")
	case <-time.After(300 * time.Millisecond):
	}
	_, err := session.RunCase(0)
	must(t, err)
	_, err = session.AfterEach(0)
	must(t, err)
	if result := <-done; result.Status != trace.Passed {
		t.Errorf("second %+v", result)
	}
	got := phases(session)
	first, second := -1, -1
	for index, entry := range got {
		if entry == "case:one:passed" {
			first = index
		}
		if entry == "before-each:two:passed" && second < 0 {
			second = index
		}
	}
	if first < 0 || second < first {
		t.Errorf("the cases overlapped: %v", got)
	}
}

func TestRule9AGuardedSuiteSkipsUnlessTheRunAllowsIt(t *testing.T) {
	refusing := NewRunContext(&Options{}, nil, nil)
	session := openText(t, hooks, refusing, true)
	session.Setup()
	result := runOne(t, session, 0)
	if result.Status != trace.Skipped || result.Message != GuardedMessage {
		t.Errorf("result %+v", result)
	}
	if session.Teardown().Ran {
		t.Error("teardown ran")
	}
	entries := session.Trace().Snapshot()
	if len(entries) != 1 || entries[0].Reason != trace.Guard {
		t.Errorf("trace %+v", entries)
	}
	allowing := NewRunContext(&Options{}, nil, nil)
	allowing.AllowGuarded = true
	if result := runOne(t, openText(t, hooks, allowing, true), 0); result.Status != trace.Passed {
		t.Errorf("allowed %+v", result)
	}
}

func TestADryRunValidatesAndTracesNothing(t *testing.T) {
	session := openText(t, hooks, ForRun(&Options{DryRun: true}, nil, &trace.Trace{}), false)
	session.Setup()
	if result := runOne(t, session, 0); result.Status != trace.Skipped {
		t.Errorf("result %+v", result)
	}
	if session.Teardown().Ran || len(session.Trace().Snapshot()) != 0 {
		t.Error("a dry run ran or traced something")
	}
}

func TestRunContextFromReadsOptionsTagsAndSwitchesUnderThePrefix(t *testing.T) {
	lab := extension.Extension{
		Name:        "lab",
		Options:     []extension.Option{{Flag: "--api-url", Description: "the API"}},
		ContextKeys: []string{"apiUrl"},
		Start: func(given map[string]string) extension.RunState {
			return extension.RunState{Context: map[string]any{"apiUrl": given["--api-url"]}}
		},
	}
	values := map[string]string{
		"BDD_SUITE_OPTION_API_URL": "https://lab/api", "BDD_SUITE_TAGS": " smoke , slow ,", "BDD_SUITE_DRY_RUN": "1",
		"BDD_SUITE_ALLOW_GUARDED": "1", "BDD_SUITE_TRACE_FILE": "out/trace.json", "BDD_SUITE_RECORD_PATH": "out/record.txt",
	}
	context, err := RunContextFrom(func(name string) string { return values[name] }, lab)
	must(t, err)
	if context.Extensions.Started.Context["apiUrl"] != "https://lab/api" || strings.Join(context.Options.Tags, ",") != "smoke,slow" ||
		!context.Options.DryRun || !context.AllowGuarded || context.TraceFile != "out/trace.json" || context.Options.RecordPath != "out/record.txt" {
		t.Errorf("context %+v %+v", context, context.Options)
	}
	if OptionVariable("--api-url") != "API_URL" || OptionVariable("--region") != "REGION" {
		t.Error("option variable names")
	}
	plain, err := RunContextFrom(func(string) string { return "" })
	must(t, err)
	if plain.AllowGuarded || plain.Options.DryRun || len(plain.Options.Tags) != 0 || plain.TraceFile != "" {
		t.Errorf("defaults %+v", plain)
	}
}

func TestWriteTraceWritesWhereTheRunContextSays(t *testing.T) {
	file := filepath.Join(t.TempDir(), "nested", "trace.json")
	context := NewRunContext(&Options{}, nil, nil)
	context.TraceFile = file
	runOne(t, openText(t, hooks, context, false), 0)
	must(t, context.WriteTrace())
	text, err := os.ReadFile(file)
	must(t, err)
	if !strings.Contains(string(text), `"case": "one"`) {
		t.Errorf("trace %s", text)
	}
	must(t, NewRunContext(&Options{}, nil, nil).WriteTrace())
}

func TestTheTraceTakesEntriesFromManyGoroutines(t *testing.T) {
	recorded := &trace.Trace{}
	var group sync.WaitGroup
	for index := 0; index < 200; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			recorded.Add(trace.Step, "c", "s", "core.noop", trace.Passed, trace.None)
		}()
	}
	group.Wait()
	if got := len(recorded.Snapshot()); got != 200 {
		t.Errorf("%d entries", got)
	}
}

func TestAModelMapDeepCloneSharesNothing(t *testing.T) {
	document, err := model.Load("a:\n  b: [1]\n")
	must(t, err)
	original, _ := document.Value.(*model.Map)
	copied := original.DeepClone()
	inner, _ := copied.Value("a").(*model.Map)
	inner.Set("b", append(inner.Value("b").([]any), 2))
	inner.Set("c", true)
	kept, _ := original.Value("a").(*model.Map)
	if len(kept.Value("b").([]any)) != 1 || kept.Has("c") {
		t.Error("the copy shares with the original")
	}
}
