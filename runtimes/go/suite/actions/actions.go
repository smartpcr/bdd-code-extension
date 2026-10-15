// Package actions is what an action is (a name, and a handler that takes the
// expanded step and a context that says when to stop) and the core actions
// this runtime implements.
//
// The core.* actions are pure: no network, no remote session. They exist so
// that execution semantics can be tested with nothing deployed, and every
// runtime implements all five, which is what makes the execute corpus runnable
// by every one. An extension (package extension) adds its own actions as
// Registrations.
package actions

import (
	"context"
	"fmt"
	"os"
	"sort"
	"time"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/trace"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/value"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

// Error is what an action failed at, so a trace can name a category rather than
// read a message back out of a string.
type Error struct {
	Message string
	Reason  trace.Reason
}

func (failure *Error) Error() string { return failure.Message }

// Failed is a plain action failure.
func Failed(message string) *Error {
	return &Error{Message: message, Reason: trace.Action}
}

// TimedOut is a failure because a limit expired.
func TimedOut(message string) *Error {
	return &Error{Message: message, Reason: trace.Timeout}
}

// AssertionFailed is a failure because a comparison did not hold.
func AssertionFailed(message string) *Error {
	return &Error{Message: message, Reason: trace.Assertion}
}

// Request is what an action is given: the step after substitution, and the
// run's context.
//
// The deadline rides on Context, which is what DEC-Y09 looks like in Go: an
// action that talks to something reads it and gives up on its own, rather than
// being abandoned by the caller.
type Request struct {
	Context context.Context
	// Action is the name the catalog gives what is being run, so one handler
	// can serve several names.
	Action string
	// Step is the step, every ${...} already expanded.
	Step *model.Map
	// RecordPath is <prefix>RECORD_PATH (BDD_SUITE_RECORD_PATH by default):
	// where core.record appends its marker, when set.
	RecordPath string
	// State is, for an extension's action, what that extension's Start
	// returned as RunState.State for this run; nil for a core action.
	State any
}

// Handler is one action.
type Handler func(*Request) (any, error)

// Registration is one action an extension (or the core) registers: its name
// and its handler.
type Registration struct {
	Name    string
	Handler Handler
}

// Wait is the name of the step that runs another step. The executor runs it
// itself, because it needs the case's deadline, trace and captures; it is
// registered with the core so that no extension can take the name.
const Wait = "wait"

// Core is every action the core registers, sorted by name: the five core.*
// actions and wait. Wait's handler is never called; the executor runs wait
// itself.
func Core() []Registration {
	registry := Registry()
	out := make([]Registration, 0, len(registry)+1)
	for _, name := range CoreNames() {
		out = append(out, Registration{Name: name, Handler: registry[name]})
	}
	out = append(out, Registration{Name: Wait, Handler: func(*Request) (any, error) {
		return nil, Failed("wait is run by the executor, not dispatched.")
	}})
	return out
}

// Registry is every core.* action this runtime implements, by name.
func Registry() map[string]Handler {
	return map[string]Handler{
		"core.noop":   noop,
		"core.set":    set,
		"core.fail":   fail,
		"core.sleep":  sleep,
		"core.record": record,
	}
}

// CoreNames is every core action name, sorted.
func CoreNames() []string {
	names := make([]string, 0, 5)
	for name := range Registry() {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// noop does nothing and says so. What a `then` step uses when its whole job is
// to carry a sentence and assert on what is already captured.
func noop(request *Request) (any, error) {
	out := model.NewMap()
	out.Set("ok", true)
	return out, nil
}

// set publishes a literal, so a fixture can capture a value without an action
// that goes somewhere to get one.
func set(request *Request) (any, error) {
	held, found := request.Step.Get("value")
	if !found {
		return nil, Failed("core.set: value is required")
	}
	return held, nil
}

// fail fails on purpose, with the message the fixture chose, so a test can
// assert on attribution rather than on whatever a real action happened to say.
func fail(request *Request) (any, error) {
	message := walk.Text(request.Step, "message")
	if message == "" {
		message = "core.fail: failed on purpose"
	}
	return nil, Failed(message)
}

// sleep sleeps, and is interruptible, which is how a limit proves it cancels
// work rather than waiting it out.
func sleep(request *Request) (any, error) {
	seconds, ok := value.AsNumber(request.Step.Value("seconds"))
	if !ok {
		seconds = 1
	}
	select {
	case <-time.After(time.Duration(seconds * float64(time.Second))):
	case <-request.Context.Done():
		return nil, TimedOut("core.sleep was cancelled before it finished.")
	}
	out := model.NewMap()
	out.Set("sleptSec", seconds)
	return out, nil
}

// record appends one marker to the trace file the run named, and returns it.
func record(request *Request) (any, error) {
	marker := walk.Text(request.Step, "marker")
	if marker == "" {
		return nil, Failed("core.record: marker is required")
	}
	if request.RecordPath != "" {
		file, err := os.OpenFile(request.RecordPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return nil, Failed(fmt.Sprintf("core.record: %s cannot be written: %v", request.RecordPath, err))
		}
		defer file.Close()
		if _, err := file.WriteString(marker + "\n"); err != nil {
			return nil, Failed(fmt.Sprintf("core.record: %s cannot be written: %v", request.RecordPath, err))
		}
	}
	out := model.NewMap()
	out.Set("marker", marker)
	return out, nil
}
