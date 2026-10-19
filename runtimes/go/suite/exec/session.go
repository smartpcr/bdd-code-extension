package exec

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/suite"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/actions"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/schema"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/trace"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

// GuardedMessage is what a skipped guarded case says (spec/session.md, rule 9).
const GuardedMessage = "guarded suite: set BDD_SUITE_ALLOW_GUARDED=1 to run it"

// RunContext is what one test process shares (spec/session.md, "run context"):
// the extensions, started once and their state shared by every session; the
// run's options; the trace; whether guarded suites may run; and where the
// trace is written. suiterun run makes one per invocation; a test process makes
// one when it starts, usually from its environment.
type RunContext struct {
	Options      *Options
	Extensions   *RunExtensions
	Trace        *trace.Trace
	AllowGuarded bool
	TraceFile    string
}

// ForRun is a run context over extensions already started, which is what
// suiterun run has: it starts them once for every file it runs.
func ForRun(options *Options, run *RunExtensions, recorded *trace.Trace) *RunContext {
	if run == nil {
		run = CoreOnly()
	}
	return &RunContext{Options: options, Extensions: run, Trace: recorded, AllowGuarded: true}
}

// NewRunContext composes the extensions and starts them once with the values of
// their options (keyed by flag, --api-url).
func NewRunContext(options *Options, composite *extension.Composite, values map[string]string) *RunContext {
	if composite == nil {
		composite = extension.CoreOnly()
	}
	return &RunContext{
		Options:    options,
		Extensions: &RunExtensions{Composite: composite, Started: extension.Start(composite, values)},
		Trace:      &trace.Trace{},
	}
}

// OptionVariable is the variable-name part of an option's flag: no leading
// dashes, upper case, - as _, so --api-url is API_URL.
func OptionVariable(flag string) string {
	return strings.ReplaceAll(strings.ToUpper(strings.TrimLeft(flag, "-")), "-", "_")
}

// RunContextFrom builds a run context from named values: <prefix>OPTION_<FLAG>,
// TAGS, DRY_RUN, ALLOW_GUARDED, TRACE_FILE and RECORD_PATH, where the prefix is
// the extensions' environment prefix. FromEnvironment passes os.Getenv. Suite
// parameters keep coming from <prefix>PARAM_<NAME> in the environment, which
// the runtime already reads.
func RunContextFrom(lookup func(string) string, extensions ...extension.Extension) (*RunContext, error) {
	composite, err := extension.Compose(extensions...)
	if err != nil {
		return nil, err
	}
	read := func(name string) string { return strings.TrimSpace(lookup(composite.EnvPrefix + name)) }
	values := map[string]string{}
	for _, option := range composite.Options {
		if given := read("OPTION_" + OptionVariable(option.Flag)); given != "" {
			values[option.Flag] = given
		}
	}
	var tags []string
	for _, tag := range strings.Split(read("TAGS"), ",") {
		if tag = strings.TrimSpace(tag); tag != "" {
			tags = append(tags, tag)
		}
	}
	held := NewRunContext(&Options{Tags: tags, DryRun: read("DRY_RUN") == "1", RecordPath: read("RECORD_PATH")}, composite, values)
	held.AllowGuarded = read("ALLOW_GUARDED") == "1"
	held.TraceFile = read("TRACE_FILE")
	return held, nil
}

// FromEnvironment is RunContextFrom over the process's environment.
func FromEnvironment(extensions ...extension.Extension) (*RunContext, error) {
	return RunContextFrom(os.Getenv, extensions...)
}

// WriteTrace writes the trace to TraceFile, when one is named. A test process
// calls it when its run ends.
func (held *RunContext) WriteTrace() error {
	if held.TraceFile == "" {
		return nil
	}
	text, err := json.MarshalIndent(held.Trace.JSON(), "", "  ")
	if err != nil {
		return err
	}
	if parent := filepath.Dir(held.TraceFile); parent != "" {
		if err := os.MkdirAll(parent, 0o755); err != nil {
			return err
		}
	}
	return os.WriteFile(held.TraceFile, append(text, '\n'), 0o600)
}

// TeardownResult is what a suite teardown did.
type TeardownResult struct {
	// Ran is false when no setup ran, so neither did the teardown (rule 6).
	Ran         bool
	Failed      bool
	Message     string
	DurationSec float64
}

type caseKind int

const (
	runKind caseKind = iota
	skippedByTag
	skippedAsGuarded
	setupFailedKind
	dryRunKind
)

type caseStage int

const (
	caseStarted caseStage = iota
	caseRan
	caseSettled
)

type caseState struct {
	name             string
	held             *model.Map
	kind             caseKind
	stage            caseStage
	status           trace.Status
	reason           trace.Reason
	message          string
	beforeEachFailed bool
	output           strings.Builder
	begun            time.Time
	timed            bool
	phases           map[string][]*model.Map
	context          *Context
	caseLimit        int64
}

func (state *caseState) fail(message string, reason trace.Reason) {
	state.status = trace.Failed
	state.message = message
	state.reason = reason
}

func (state *caseState) skip(kind caseKind, message string, reason trace.Reason) {
	state.kind = kind
	state.status = trace.Skipped
	state.message = message
	state.reason = reason
}

func (state *caseState) result(afterEachFailed bool) CaseResult {
	message := state.message
	if state.kind == runKind {
		message = strings.TrimSpace(message)
	}
	duration := 0.0
	if state.timed {
		duration = time.Since(state.begun).Seconds()
	}
	return CaseResult{
		Name: state.name, Status: state.status, Reason: state.reason, AfterEachFailed: afterEachFailed,
		Message: message, Output: state.output.String(), DurationSec: duration,
	}
}

// Session is one suite file run a phase at a time, so a test framework can
// call the suite setup, one case and the teardown when it chooses
// (spec/session.md). RunFile is these same calls in order, so a native test
// run and a suiterun run of a file produce the same results and the same trace.
// Setup and BeforeEach never fail for a step: they record it and the case
// reports it (rule 3); every case starts from a deep copy of the setup's bag
// (rule 5); one case runs at a time (rule 7).
type Session struct {
	// Path is the suite file; Name its declared name; Cases its case names in
	// file order, examples rows in row order.
	Path    string
	Name    string
	Cases   []string
	Context *RunContext
	Guarded bool

	suiteModel  *model.Map
	loaded      *schema.Schema
	library     *suite.Library
	definitions map[string]*model.Map
	hooks       map[string][]*model.Map
	cases       []*model.Map
	selected    []bool
	states      []*caseState

	gate       sync.Mutex
	caseLock   sync.Mutex
	suiteScope *model.Map
	setupRan   bool
	setupError string
	tornDown   bool
}

// Open opens a parsed suite. Nothing runs and nothing is linted: this is what
// RunFile uses, which has always run a file as it finds it. A test process
// lints a file first (suitetest).
func Open(path string, suiteModel *model.Map, loaded *schema.Schema, context *RunContext, guarded bool) (*Session, error) {
	library, err := suite.ReadLibraries(suiteModel, path)
	if err != nil {
		return nil, err
	}
	definitions := suite.MetaDefinitions(suiteModel, library)
	hooks, err := suite.ExpandedHooks(suiteModel, definitions)
	if err != nil {
		return nil, err
	}
	// The name a report carries is the one the file declares, not the file name.
	name := walk.Text(suiteModel, "suite")
	if name == "" {
		name = baseName(path)
	}
	held := &Session{
		Path: path, Name: name, Context: context, Guarded: guarded,
		suiteModel: suiteModel, loaded: loaded, library: library, definitions: definitions, hooks: hooks,
		cases: suite.Cases(suiteModel),
	}
	for _, one := range held.cases {
		held.Cases = append(held.Cases, walk.Text(one, "name"))
		held.selected = append(held.selected, suite.TagsMatch(suite.CaseTags(suiteModel, one), context.Options.Tags))
	}
	held.states = make([]*caseState, len(held.cases))
	// The suite bag: filled once before the first selected case and read by the
	// teardown after the last.
	held.suiteScope = model.NewMap()
	held.suiteScope.Set("capture", model.NewMap())
	held.suiteScope.Set("var", model.NewMap())
	return held, nil
}

// Trace is the run context's trace so far.
func (held *Session) Trace() *trace.Trace { return held.Context.Trace }

// IndexOf is the position of a case by its exact name.
func (held *Session) IndexOf(caseName string) (int, error) {
	for index, name := range held.Cases {
		if name == caseName {
			return index, nil
		}
	}
	return -1, fmt.Errorf("%s has no case named %q", held.Name, caseName)
}

// IsSelected says whether the run context's tag filter selects a case.
func (held *Session) IsSelected(index int) bool { return held.selected[index] }

func (held *Session) refusedAsGuarded() bool { return held.Guarded && !held.Context.AllowGuarded }

func (held *Session) newContext(scope *model.Map) *Context {
	return &Context{Scope: scope, RecordPath: held.Context.Options.RecordPath, Run: held.Context.Extensions}
}

// Setup runs the suite setup, once (rule 2): only when a case is selected, the
// run is not a dry run and the suite is not a guarded one the run context
// refuses. A failure is recorded, never returned (rule 3).
func (held *Session) Setup() {
	held.gate.Lock()
	defer held.gate.Unlock()
	anySelected := false
	for _, one := range held.selected {
		anySelected = anySelected || one
	}
	if held.setupRan || held.Context.Options.DryRun || !anySelected || held.refusedAsGuarded() {
		return
	}
	held.setupRan = true
	if len(held.hooks["setup"]) == 0 {
		return
	}
	context := held.newContext(held.suiteScope.DeepClone())
	failure := runHook(held.hooks["setup"], context, held.loaded,
		limitOf(held.suiteModel, "setupTimeoutSec", defaultHookSec),
		"suite setup", trace.SuiteSetup, "", held.Context.Trace)
	held.suiteScope = context.Scope
	if failure != nil {
		held.setupError = failure.Error()
	}
}

// BeforeEach starts one case: it takes the case lock, runs the setup if it has
// not run, builds the case's scope from a deep copy of the setup's bag, and
// runs beforeEach. A failure is recorded for RunCase to report. The error is
// only for a suite that cannot be expanded or a case it does not have.
func (held *Session) BeforeEach(index int) (err error) {
	held.caseLock.Lock()
	defer func() {
		if err != nil {
			held.states[index] = nil
			held.caseLock.Unlock()
		}
	}()
	one := held.cases[index]
	state := &caseState{name: held.Cases[index], held: one, status: trace.Passed, reason: trace.None}
	held.states[index] = state
	if !held.selected[index] {
		state.skip(skippedByTag, "tag filter", trace.Tag)
		return nil
	}
	if held.refusedAsGuarded() {
		state.skip(skippedAsGuarded, GuardedMessage, trace.Guard)
		return nil
	}
	held.Setup()
	if held.setupError != "" {
		state.kind = setupFailedKind
		state.status = trace.Error
		state.reason = trace.SuiteSetupFail
		state.message = "Suite setup failed: " + held.setupError
		return nil
	}
	if held.Context.Options.DryRun {
		state.skip(dryRunKind, "Validated only; live execution pending.", trace.None)
		return nil
	}
	if err := held.prepare(state); err != nil {
		return err
	}
	if failure := runHook(held.hooks["beforeEach"], state.context, held.loaded,
		limitOf(held.suiteModel, "beforeEachTimeoutSec", defaultHookSec),
		"beforeEach", trace.BeforeEach, state.name, held.Context.Trace); failure != nil {
		state.fail(failure.Error(), reasonOf(failure))
		state.beforeEachFailed = true
	}
	return nil
}

// prepare builds the case's scope: a deep copy of the setup's bag, then its
// parameters, row, defaults, limit, context keys and variables.
func (held *Session) prepare(state *caseState) error {
	run := held.Context.Extensions
	state.begun = time.Now()
	state.timed = true
	phases, err := suite.ExpandedCase(state.held, held.definitions)
	if err != nil {
		return err
	}
	state.phases = phases
	scope := held.suiteScope.DeepClone()
	scope.Set("param", suite.ResolveParams(held.library, held.suiteModel, state.held, held.Context.Options.Params, run.Composite.EnvPrefix))
	if row, found := state.held.Get("__row"); found {
		scope.Set("row", row)
	}
	defaults := held.library.Defaults.Clone()
	if declared, ok := walk.AsMap(held.suiteModel.Value("defaults")); ok {
		for _, key := range declared.Keys() {
			defaults.Set(key, declared.Value(key))
		}
	}
	for _, key := range defaults.Keys() {
		scope.Set(key, defaults.Value(key))
	}
	scope.Set("defaults", defaults)
	scope.Set("timeoutSec", limitOf(state.held, "timeoutSec", defaultCaseSec))
	// The extensions' context keys: a value given for this run wins over the
	// suite's defaults; a key with neither reads as "".
	for _, key := range run.Composite.ContextKeys {
		if given, found := run.Started.Context[key]; found {
			scope.Set(key, given)
		} else if !scope.Has(key) {
			scope.Set(key, "")
		}
	}
	if err := suite.ResolveVars(held.library, held.suiteModel, state.held, scope, run.Composite.Roots...); err != nil {
		return err
	}
	state.context = held.newContext(scope)
	state.caseLimit = run.Composite.CaseLimitSec(held.suiteModel, limitOf(state.held, "timeoutSec", defaultCaseSec))
	return nil
}

func reasonOf(failure error) trace.Reason {
	if refused, ok := failure.(*actions.Error); ok {
		return refused.Reason
	}
	return trace.Action
}

// inProgress is the state of a case BeforeEach started and AfterEach has not
// settled; any other order is refused rather than run (rule 1).
func (held *Session) inProgress(index int, operation string) (*caseState, error) {
	state := held.states[index]
	if state == nil || state.stage == caseSettled {
		return nil, fmt.Errorf("%s for %q needs BeforeEach first", operation, held.Cases[index])
	}
	return state, nil
}

// RunCase runs the case itself: its setup, steps and case-level asserts, then
// its cleanup, which runs even after a failure. A recorded setup or beforeEach
// failure is reported here as the case's result, exactly as RunFile does. The
// result is final only after AfterEach.
func (held *Session) RunCase(index int) (CaseResult, error) {
	state, err := held.inProgress(index, "RunCase")
	if err != nil {
		return CaseResult{}, err
	}
	if state.stage != caseStarted {
		return CaseResult{}, fmt.Errorf("RunCase for %q was called twice; call BeforeEach again to run it again", state.name)
	}
	state.stage = caseRan
	if state.kind == runKind {
		held.runBody(state)
		held.runCleanup(state)
	}
	return state.result(false), nil
}

func (held *Session) runBody(state *caseState) {
	if state.beforeEachFailed {
		return
	}
	failure := runCase(state.held, state.phases, state.context, held.loaded, state.name, state.caseLimit, held.Context.Trace, &state.output)
	if failure != nil {
		state.fail(failure.Error(), reasonOf(failure))
	}
}

// runCleanup runs the case's cleanup in its own bounded window, even after the
// case timed out.
func (held *Session) runCleanup(state *caseState) {
	if len(state.phases["cleanup"]) == 0 {
		return
	}
	if failure := runHook(state.phases["cleanup"], state.context, held.loaded,
		limitOf(state.held, "cleanupTimeoutSec", defaultCleanupSec),
		"cleanup", trace.CaseCleanup, state.name, held.Context.Trace); failure != nil {
		state.status = trace.Failed
		state.reason = trace.Cleanup
		state.message = state.message + " Cleanup failed: " + failure.Error()
	}
}

// AfterEach finishes one case: it runs afterEach, settles the case's result
// (an afterEach failure makes it failed with reason hook), writes its case
// trace entry, and releases the case lock (rule 4). AfterEachFailed in the
// result says whether the framework's per-test cleanup should fail.
func (held *Session) AfterEach(index int) (CaseResult, error) {
	state, err := held.inProgress(index, "AfterEach")
	if err != nil {
		return CaseResult{}, err
	}
	defer held.caseLock.Unlock()
	if state.kind == runKind && state.stage == caseStarted {
		// The framework ran beforeEach but never the case. Its cleanup is still
		// owed, and the case did not pass.
		state.fail("The test framework ran this case's beforeEach but not the case itself.", trace.Hook)
		held.runCleanup(state)
	}
	afterEachFailed := false
	if state.kind == runKind {
		if failure := runHook(held.hooks["afterEach"], state.context, held.loaded,
			limitOf(held.suiteModel, "afterEachTimeoutSec", defaultHookSec),
			"afterEach", trace.AfterEach, state.name, held.Context.Trace); failure != nil {
			state.status = trace.Failed
			state.reason = trace.Hook
			state.message = state.message + " afterEach failed: " + failure.Error()
			afterEachFailed = true
		}
	}
	// A dry run validates and runs nothing, so it traces nothing either.
	if state.kind != dryRunKind {
		held.Context.Trace.Add(trace.Case, state.name, "", "", state.status, state.reason)
	}
	state.stage = caseSettled
	return state.result(afterEachFailed), nil
}

// Teardown runs the suite teardown, once, on the setup's bag, if the setup ran
// (rule 6), after any case in progress finishes. Its failure is returned in
// the result, never as an error.
func (held *Session) Teardown() TeardownResult {
	held.caseLock.Lock()
	defer held.caseLock.Unlock()
	held.gate.Lock()
	if held.tornDown || !held.setupRan {
		held.gate.Unlock()
		return TeardownResult{}
	}
	held.tornDown = true
	held.gate.Unlock()
	if len(held.hooks["teardown"]) == 0 {
		return TeardownResult{Ran: true}
	}
	begun := time.Now()
	failure := runHook(held.hooks["teardown"], held.newContext(held.suiteScope), held.loaded,
		limitOf(held.suiteModel, "teardownTimeoutSec", defaultHookSec),
		"suite teardown", trace.SuiteTeardown, "", held.Context.Trace)
	if failure != nil {
		return TeardownResult{Ran: true, Failed: true, Message: failure.Error(), DurationSec: time.Since(begun).Seconds()}
	}
	return TeardownResult{Ran: true, DurationSec: time.Since(begun).Seconds()}
}
