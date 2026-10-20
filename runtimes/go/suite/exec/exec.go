// Package exec runs a suite: the six phases, the limit chain, captures and
// assertions.
//
// The order is DEC-Y07's: suite setup once, then for each case beforeEach, the
// case setup, its steps, its cleanup and afterEach, and the suite teardown once
// at the end. A failed suite setup errors every case and the teardown still
// runs, because state a half-built setup left still has to be undone.
//
// A step is bounded by the smaller of its own limit and what remains of the
// case (DEC-Y08). The bound rides on a context.Context handed to the action,
// which is the idiomatic form of DEC-Y09: an action that waits on something
// gives up by itself. An action that ignores it is abandoned instead, on its
// own goroutine, and the case sees the same thing either way: a failure naming
// the limit it broke.
//
// Every action is dispatched through the run's composite (package extension):
// the core's, wait, and every extension's. An action no extension registers
// fails its step by name.
package exec

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/assertion"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/suite"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/actions"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/expr"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/schema"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/trace"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/value"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

// The fallbacks for a limit nobody declared. An extension may lower a case's
// limit (extension.Rules.CaseLimitSec); nothing raises it.
const (
	defaultCaseSec    = 600
	defaultHookSec    = 300
	defaultCleanupSec = 120
)

// Options is how a run was asked to be done.
type Options struct {
	Tags []string
	// Names is the --name globs; see suite.NameMatches.
	Names  []string
	Params [][2]string
	DryRun bool
	// Observer is told of each selected case and each trace entry as the run
	// goes (spec/progress.md). It never changes what the run does or what the
	// trace holds.
	Observer Observer
	// RecordPath is <prefix>RECORD_PATH: where core.record appends.
	RecordPath string
}

// Observer is told when a selected case starts and finishes, and of each trace
// entry as it is recorded, so a long run can say what it is doing while it does
// it (spec/progress.md). An observer sees the run; it cannot change it.
type Observer interface {
	CaseStarted(suite, caseName string)
	CaseFinished(suite string, result CaseResult)
	Entry(entry trace.Entry)
}

// RunExtensions is the extensions of one run, composed, and started with the
// run's option values.
type RunExtensions struct {
	Composite *extension.Composite
	Started   *extension.Started
}

// CoreOnly is the core alone: no extension, nothing started.
func CoreOnly() *RunExtensions {
	composite := extension.CoreOnly()
	return &RunExtensions{Composite: composite, Started: extension.Start(composite, nil)}
}

// CaseResult is what one case did.
type CaseResult struct {
	Name   string
	Status trace.Status
	// Reason is the trace's reason when the case did not pass.
	Reason trace.Reason
	// AfterEachFailed says whether the afterEach block failed, which a test
	// framework shows as a failure of its per-test cleanup (spec/session.md,
	// rule 4).
	AfterEachFailed bool
	Message         string
	Output          string
	DurationSec     float64
}

// SuiteResult is what one suite file did.
type SuiteResult struct {
	Name  string
	Cases []CaseResult
}

// RunResult is what a whole run did.
type RunResult struct {
	Suites []SuiteResult
	Trace  *trace.Trace
}

// Context is the bag one case reads and writes.
type Context struct {
	Scope      *model.Map
	RecordPath string
	Run        *RunExtensions
}

// extensions is the run's extensions, or the core alone when none were given.
func (held *Context) extensions() *RunExtensions {
	if held.Run == nil {
		held.Run = CoreOnly()
	}
	return held.Run
}

// scope is an expression scope over this context, with the run's roots.
func (held *Context) scope() *expr.Scope {
	return expr.NewScope(held.Scope, held.extensions().Composite.Roots...)
}

func (held *Context) capture(name string, produced any) {
	bag, ok := walk.AsMap(held.Scope.Value("capture"))
	if !ok {
		bag = model.NewMap()
		held.Scope.Set("capture", bag)
	}
	bag.Set(name, produced)
}

func (held *Context) has(name string) bool {
	bag, ok := walk.AsMap(held.Scope.Value("capture"))
	if !ok {
		return false
	}
	_, found := bag.Get(name)
	if found {
		return true
	}
	var current any = bag
	for _, part := range strings.Split(name, ".") {
		if part == "" {
			return false
		}
		object, ok := walk.AsMap(current)
		if !ok {
			return false
		}
		current, found = object.Get(part)
		if !found {
			return false
		}
	}
	return true
}

// actualValue walks a dotted subject into the capture bag, and says whether it
// was there at all. Absent and null are different things to isNull and
// isNotNull, and the same to nothing else.
func actualValue(path string, held *Context) (any, bool) {
	bag, found := held.Scope.Get("capture")
	if !found {
		return nil, false
	}
	current := bag
	for _, segment := range strings.Split(path, ".") {
		if current == nil {
			return nil, false
		}
		if items, ok := current.([]any); ok {
			index := -1
			if _, err := fmt.Sscanf(segment, "%d", &index); err == nil && index >= 0 {
				if index >= len(items) {
					return nil, false
				}
				current = items[index]
				continue
			}
		}
		next, ok := expr.Field(current, segment)
		if !ok {
			return nil, false
		}
		current = next
	}
	return current, true
}

// checkAssertion compares one assertion and fails when it does not hold. Every
// operator in one assertion has to pass, and the first failure ends the case.
func checkAssertion(raw any, held *Context) error {
	expanded, err := expr.Expand(raw, held.scope())
	if err != nil {
		return actions.Failed(err.Error())
	}
	one, ok := walk.AsMap(expanded)
	if !ok {
		return nil
	}
	subject := "(value)"
	var found any
	present := false
	if variable := walk.Text(one, "var"); variable != "" {
		subject = variable
		found, present = actualValue(variable, held)
	}
	for _, operator := range one.Keys() {
		if operator == "var" {
			continue
		}
		if operator == "script" {
			// PowerShell only, and refused elsewhere by the catalog's binding
			// list. A binding that does not run the host language says so rather
			// than passing an assertion it did not make.
			return actions.AssertionFailed(
				"a script assertion is implemented by the PowerShell binding only")
		}
		expected := one.Value(operator)
		holds, failure := assertion.Compare(operator, found, expected, present)
		if failure != nil {
			return actions.AssertionFailed(failure.Error())
		}
		if !holds {
			return actions.AssertionFailed(assertion.Describe(subject, operator, expected, found, present))
		}
	}
	return nil
}

// bounded runs one action with a limit, and gives up on it when the limit
// expires.
func bounded(
	name string,
	step *model.Map,
	held *Context,
	limitSec int64,
	description string,
	interruptible bool,
) (any, error) {
	if limitSec <= 0 {
		return nil, actions.TimedOut(fmt.Sprintf(
			"%s had no time left to run in: the deadline had already passed.", description))
	}
	run := held.extensions()
	registered, found := run.Composite.Actions[name]
	if !found {
		return nil, actions.Failed("Unknown action: " + name + ". No extension of this runtime registers it.")
	}

	limited, release := context.WithTimeout(context.Background(), time.Duration(limitSec)*time.Second)
	defer release()
	request := &actions.Request{
		Context: limited, Action: name, Step: step, RecordPath: held.RecordPath,
		State: run.Started.State(registered.Owner),
	}

	type answer struct {
		produced any
		failure  error
	}
	// Buffered, so an abandoned action can finish and exit rather than blocking
	// on a channel nobody is reading any more.
	done := make(chan answer, 1)
	go func() {
		// A panic is this step's failure, never the end of the process, which
		// would lose every result and every cleanup still to come
		// (spec/progress.md, "The action worker").
		defer func() {
			if recovered := recover(); recovered != nil {
				done <- answer{nil, actions.Failed(fmt.Sprintf("%s panicked: %v", name, recovered))}
			}
		}()
		produced, failure := registered.Handler(request)
		done <- answer{produced, failure}
	}()

	select {
	case got := <-done:
		return got.produced, got.failure
	case <-limited.Done():
		wording := "cancelled"
		if !interruptible {
			wording = "abandoned: it holds a remote session this runner cannot interrupt, so the work on the far side continues"
		}
		return nil, actions.TimedOut(fmt.Sprintf(
			"%s exceeded its %ds limit and was %s.", description, limitSec, wording))
	}
}

// wait sleeps, or polls a nested step until an assertion holds.
//
// The nested step runs inline rather than on its own goroutine: the poll is
// inside the bound its parent already holds, and a step that fails transiently
// is tried again rather than ending the case.
func wait(
	step *model.Map,
	held *Context,
	loaded *schema.Schema,
	deadline time.Time,
	phase trace.Phase,
	caseName string,
	recorded *trace.Trace,
) (any, error) {
	nested, hasNested := walk.AsMap(step.Value("forStep"))
	seconds, _ := value.AsNumber(step.Value("seconds"))
	if seconds > 0 && !hasNested {
		time.Sleep(time.Duration(seconds * float64(time.Second)))
		out := model.NewMap()
		out.Set("waitedSec", seconds)
		return out, nil
	}
	if !hasNested {
		return nil, actions.Failed("wait needs either seconds, or a forStep to poll.")
	}

	intervalSec := int64(10)
	if given, ok := step.Value("intervalSec").(int64); ok && given > 0 {
		intervalSec = given
	}
	interval := time.Duration(intervalSec) * time.Second
	ownSec := int64(300)
	if given, ok := step.Value("timeoutSec").(int64); ok && given > 0 {
		ownSec = given
	}
	until := time.Now().Add(time.Duration(ownSec) * time.Second)
	if until.After(deadline) {
		until = deadline
	}
	started := time.Now()
	for {
		collected := map[string][]any{}
		_, failure := runStep(nested, held, loaded, until, phase, caseName, recorded, collected)
		if failure == nil {
			assertions, found := step.Get("until")
			if !found || assertions == nil {
				return waited(started), nil
			}
			if checkAssertion(assertions, held) == nil {
				return waited(started), nil
			}
		}
		if time.Now().Add(interval).After(until) {
			return nil, actions.TimedOut(fmt.Sprintf(
				"wait gave up after %ds: the step it polls never satisfied its until.",
				int64(time.Since(started).Seconds())))
		}
		time.Sleep(interval)
	}
}

func waited(started time.Time) *model.Map {
	out := model.NewMap()
	out.Set("waited", true)
	out.Set("elapsedSec", int64(time.Since(started).Seconds()))
	return out
}

// runStep runs one step: guard, substitute, act, capture, assert.
func runStep(
	step *model.Map,
	held *Context,
	loaded *schema.Schema,
	deadline time.Time,
	phase trace.Phase,
	caseName string,
	recorded *trace.Trace,
	collected map[string][]any,
) (any, error) {
	label := suite.StepLabel(step)
	action := walk.Text(step, "action")
	guard := walk.Text(step, "ifCapture")
	if guard != "" && !held.has(guard) {
		recorded.Add(phase, caseName, label, action, trace.Skipped, trace.Guard)
		return nil, nil
	}

	// The row is bound for this step only: ${row.<column>} reads the row it came
	// from, and the next step sees whatever its own row is, or none.
	if row, found := step.Get("__row"); found {
		held.Scope.Set("row", row)
	}

	raw, failure := expr.Expand(step, held.scope())
	if failure != nil {
		refused := actions.Failed(fmt.Sprintf("%s: %v", label, failure))
		recorded.Add(phase, caseName, label, action, trace.Failed, refused.Reason)
		return nil, refused
	}
	expanded, _ := walk.AsMap(raw)
	if action == "" {
		refused := actions.Failed(fmt.Sprintf("%s: a step names no action", label))
		recorded.Add(phase, caseName, label, "", trace.Failed, refused.Reason)
		return nil, refused
	}

	remaining := int64(time.Until(deadline).Seconds())
	if remaining < 0 {
		remaining = 0
	}
	own := int64(0)
	if given, ok := expanded.Value("timeoutSec").(int64); ok {
		own = given
	}
	limit := suite.StepLimit(own, remaining)
	interruptible := true
	if declared, found := loaded.Actions[action]; found {
		interruptible = declared.Interruptible
	}

	// `wait` runs another step, so it is the executor's business rather than an
	// entry in the registry: the nested step runs inline, inside the bound its
	// parent already holds, and publishes its capture where the parent can read
	// it.
	var produced any
	var acted error
	if action == actions.Wait {
		produced, acted = wait(expanded, held, loaded, deadline, phase, caseName, recorded)
	} else {
		produced, acted = bounded(action, expanded, held, limit, label, interruptible)
	}
	if acted != nil {
		reason := trace.Action
		message := acted.Error()
		if failure, ok := acted.(*actions.Error); ok {
			reason = failure.Reason
		}
		recorded.Add(phase, caseName, label, action, trace.Failed, reason)
		if !strings.HasPrefix(message, label) {
			message = label + ": " + message
		}
		return nil, &actions.Error{Message: message, Reason: reason}
	}

	// A step's capture is its own result while its own assertions run, and only
	// then collected into the list a table publishes. That is what lets a
	// per-row assertion say `seen.marker` and mean this row's result.
	captureAs := walk.Text(expanded, "captureAs")
	if captureAs != "" {
		held.capture(captureAs, produced)
	}
	assertions, _ := walk.List(step, "asserts")
	for _, one := range assertions {
		if one == nil {
			continue
		}
		if failure := checkAssertion(one, held); failure != nil {
			reason := trace.Assertion
			if refused, ok := failure.(*actions.Error); ok {
				reason = refused.Reason
			}
			recorded.Add(phase, caseName, label, action, trace.Failed, reason)
			return nil, &actions.Error{Message: label + ": " + failure.Error(), Reason: reason}
		}
	}
	if captureAs != "" && step.Has("__rowCount") {
		collected[captureAs] = append(collected[captureAs], produced)
		published := make([]any, len(collected[captureAs]))
		copy(published, collected[captureAs])
		held.capture(captureAs, published)
	}

	recorded.Add(phase, caseName, label, action, trace.Passed, trace.None)
	return produced, nil
}

// runHook runs one hook list inside its own window.
func runHook(
	steps []*model.Map,
	held *Context,
	loaded *schema.Schema,
	limitSec int64,
	label string,
	phase trace.Phase,
	caseName string,
	recorded *trace.Trace,
) error {
	if len(steps) == 0 {
		return nil
	}
	if limitSec < 1 {
		limitSec = 1
	}
	deadline := time.Now().Add(time.Duration(limitSec) * time.Second)
	collected := map[string][]any{}
	for _, step := range steps {
		if _, failure := runStep(step, held, loaded, deadline, phase, caseName, recorded, collected); failure != nil {
			// The category is the hook rather than whatever the action was
			// doing: a case whose setup failed did not fail at one of its own
			// steps, and a trace that said 'action' would send a reader looking
			// for one.
			return &actions.Error{Message: label + " " + failure.Error(), Reason: trace.Hook}
		}
	}
	return nil
}

func limitOf(held *model.Map, key string, fallback int64) int64 {
	if given, ok := held.Value(key).(int64); ok {
		return given
	}
	return fallback
}

// RunFile runs one suite file: the whole-file run every suiterun run does,
// built on the session a test framework drives a phase at a time
// (spec/session.md). The suite setup runs before the first case, as it always
// has, so a case a tag filter skips is traced after it; then each case through
// BeforeEach, RunCase and AfterEach; then the teardown, whose failure is its own
// entry.
func RunFile(
	path string,
	suiteModel *model.Map,
	loaded *schema.Schema,
	options *Options,
	run *RunExtensions,
	recorded *trace.Trace,
) (SuiteResult, error) {
	session, err := Open(path, suiteModel, loaded, ForRun(options, run, recorded), false)
	if err != nil {
		return SuiteResult{}, err
	}
	result := SuiteResult{Name: session.Name}
	// A dry run traces nothing, so its observer hears nothing either.
	observer := options.Observer
	if options.DryRun {
		observer = nil
	}
	if observer != nil {
		previous := recorded.OnAdded(observer.Entry)
		defer recorded.OnAdded(previous)
	}
	session.Setup()
	for index := range session.Cases {
		// Only the cases this run selected are reported (spec/progress.md).
		observed := observer != nil && session.IsSelected(index)
		if observed {
			observer.CaseStarted(session.Name, session.Cases[index])
		}
		if err := session.BeforeEach(index); err != nil {
			return SuiteResult{}, err
		}
		if _, err := session.RunCase(index); err != nil {
			return SuiteResult{}, err
		}
		settled, err := session.AfterEach(index)
		if err != nil {
			return SuiteResult{}, err
		}
		result.Cases = append(result.Cases, settled)
		if observed {
			observer.CaseFinished(session.Name, settled)
		}
	}

	// A teardown that fails is its own entry rather than a change to the last
	// case's result, because a teardown is not a test and the case it would be
	// charged to did nothing wrong. It does fail the run: a suite whose teardown
	// could not undo what it did has not finished cleanly.
	if teardown := session.Teardown(); teardown.Failed {
		result.Cases = append(result.Cases, CaseResult{
			Name: "teardown", Status: trace.Failed, Reason: trace.Hook,
			Message: teardown.Message, DurationSec: teardown.DurationSec,
		})
	}
	return result, nil
}

// runCase is the case's own setup, steps and case-level asserts: the part a
// cleanup and an afterEach run after, whether it succeeded or not.
func runCase(
	held *model.Map,
	phases map[string][]*model.Map,
	context *Context,
	loaded *schema.Schema,
	caseName string,
	caseLimit int64,
	recorded *trace.Trace,
	output *strings.Builder,
) error {
	if failure := runHook(phases["setup"], context, loaded,
		limitOf(held, "setupTimeoutSec", defaultHookSec),
		"case setup", trace.CaseSetup, caseName, recorded); failure != nil {
		return failure
	}
	// The case's own limit starts here, after the hooks, because a hook never
	// draws on it.
	if caseLimit < 1 {
		caseLimit = 1
	}
	deadline := time.Now().Add(time.Duration(caseLimit) * time.Second)
	collected := map[string][]any{}
	for _, step := range phases["steps"] {
		produced, failure := runStep(step, context, loaded, deadline, trace.Step, caseName, recorded, collected)
		if failure != nil {
			return failure
		}
		if produced != nil {
			text, err := json.Marshal(produced)
			if err == nil {
				output.Write(text)
				output.WriteByte('\n')
			}
		}
	}
	assertions, _ := walk.List(held, "asserts")
	for _, one := range assertions {
		if one == nil {
			continue
		}
		if failure := checkAssertion(one, context); failure != nil {
			return failure
		}
	}
	return nil
}

// Failed says whether a run failed, which is what decides between exit 0 and
// exit 1.
func Failed(result *RunResult) bool {
	for _, one := range result.Suites {
		for _, held := range one.Cases {
			if held.Status == trace.Failed || held.Status == trace.Error {
				return true
			}
		}
	}
	return false
}

// AllNames is every action name this runtime implements, sorted: the core
// actions, wait, and every extension's. A portability check is answered from
// the whole list. The core alone when composite is nil.
func AllNames(composite *extension.Composite) []string {
	if composite == nil {
		composite = extension.CoreOnly()
	}
	return composite.Names()
}

func baseName(path string) string {
	at := strings.LastIndexAny(path, `/\`)
	name := path[at+1:]
	if dot := strings.LastIndex(name, "."); dot > 0 {
		name = name[:dot]
	}
	return name
}
