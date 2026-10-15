package actions

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/trace"
)

func ask(pairs ...any) *Request {
	step := model.NewMap()
	for index := 0; index+1 < len(pairs); index += 2 {
		name, _ := pairs[index].(string)
		step.Set(name, pairs[index+1])
	}
	return &Request{Context: context.Background(), Step: step}
}

func TestEveryCoreActionIsRegistered(t *testing.T) {
	registry := Registry()
	for _, name := range []string{"core.noop", "core.set", "core.fail", "core.sleep", "core.record"} {
		if _, found := registry[name]; !found {
			t.Errorf("%s is not registered", name)
		}
	}
	names := CoreNames()
	if len(names) != 5 {
		t.Fatalf("%d names", len(names))
	}
	for index := 1; index < len(names); index++ {
		if names[index-1] > names[index] {
			t.Error("the names do not come out in one order")
		}
	}
}

func TestNoopSaysItDidNothingSuccessfully(t *testing.T) {
	produced, err := noop(ask())
	if err != nil {
		t.Fatal(err)
	}
	held, _ := produced.(*model.Map)
	if held.Value("ok") != true {
		t.Errorf("it produced %v", produced)
	}
}

func TestSetPublishesTheLiteralItWasGiven(t *testing.T) {
	produced, err := set(ask("value", "x"))
	if err != nil || produced != "x" {
		t.Errorf("it produced %v, %v", produced, err)
	}
	produced, err = set(ask("value", []any{int64(1), int64(2)}))
	if err != nil {
		t.Fatal(err)
	}
	if items, ok := produced.([]any); !ok || len(items) != 2 {
		t.Errorf("it produced %v", produced)
	}
	if _, err := set(ask()); err == nil || !strings.Contains(err.Error(), "value is required") {
		t.Errorf("it said %v", err)
	}
}

func TestFailFailsWithTheWordingTheFixtureChose(t *testing.T) {
	_, err := fail(ask())
	if err == nil || !strings.Contains(err.Error(), "failed on purpose") {
		t.Errorf("it said %v", err)
	}
	_, err = fail(ask("message", "chosen"))
	if err == nil || err.Error() != "chosen" {
		t.Errorf("it said %v", err)
	}
	if failure, ok := err.(*Error); !ok || failure.Reason != trace.Action {
		t.Errorf("the category is %v", err)
	}
}

func TestSleepReportsWhatItSleptAndStopsWhenItIsCancelled(t *testing.T) {
	produced, err := sleep(ask("seconds", 0.01))
	if err != nil {
		t.Fatal(err)
	}
	held, _ := produced.(*model.Map)
	if held.Value("sleptSec") != 0.01 {
		t.Errorf("it slept %v", held.Value("sleptSec"))
	}
	// The default is one second when the step names none, which the cancelled
	// case below relies on outlasting its own deadline.
	limited, release := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer release()
	request := ask()
	request.Context = limited
	started := time.Now()
	_, err = sleep(request)
	if err == nil {
		t.Fatal("a cancelled sleep finished")
	}
	if failure, ok := err.(*Error); !ok || failure.Reason != trace.Timeout {
		t.Errorf("the category is %v", err)
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Errorf("it waited the limit out: %v", elapsed)
	}
}

func TestRecordWritesTheMarkerAndReturnsIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "record.txt")
	for _, marker := range []string{"first", "second"} {
		request := ask("marker", marker)
		request.RecordPath = path
		produced, err := record(request)
		if err != nil {
			t.Fatal(err)
		}
		held, _ := produced.(*model.Map)
		if held.Value("marker") != marker {
			t.Errorf("it returned %v", produced)
		}
	}
	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(written)) != "first\nsecond" {
		t.Errorf("the file holds %q", written)
	}
}

func TestRecordWithNowhereToWriteStillReturnsItsMarker(t *testing.T) {
	produced, err := record(ask("marker", "loose"))
	if err != nil {
		t.Fatal(err)
	}
	held, _ := produced.(*model.Map)
	if held.Value("marker") != "loose" {
		t.Errorf("it returned %v", produced)
	}
	if _, err := record(ask()); err == nil || !strings.Contains(err.Error(), "marker is required") {
		t.Errorf("it said %v", err)
	}
	request := ask("marker", "x")
	request.RecordPath = filepath.Join(t.TempDir(), "nosuch", "deeper", "record.txt")
	if _, err := record(request); err == nil {
		t.Error("a path that cannot be opened was written to")
	}
}

func TestAFailureCarriesTheCategoryATraceNames(t *testing.T) {
	if TimedOut("x").Reason != trace.Timeout {
		t.Error("a timeout")
	}
	if AssertionFailed("x").Reason != trace.Assertion {
		t.Error("an assertion")
	}
	if Failed("x").Error() != "x" {
		t.Error("a plain failure")
	}
}
