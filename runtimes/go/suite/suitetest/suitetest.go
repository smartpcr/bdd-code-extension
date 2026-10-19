// Package suitetest runs suites as go test tests (docs/test-providers, D8):
// what the code suiterun generate writes calls. Main starts the run context
// once for the test binary; Open opens one suite for a TestSuite_<id> function,
// whose t.Cleanup runs the suite teardown; Case is one case's subtest, which
// runs beforeEach, the case and afterEach through the session
// (spec/session.md).
package suitetest

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/validate"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/diag"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/exec"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/schema"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/trace"
)

var (
	gate    sync.Mutex
	current *exec.RunContext
	schemas = map[string]*schema.Schema{}
)

// Main starts the run context from the environment (<prefix>OPTION_*, TAGS,
// DRY_RUN, ALLOW_GUARDED, TRACE_FILE, RECORD_PATH), runs the tests, and writes
// the trace. The generated TestMain is os.Exit(suitetest.Main(m, ext...)).
func Main(m *testing.M, extensions ...extension.Extension) int {
	context, err := exec.FromEnvironment(extensions...)
	if err != nil {
		fmt.Fprintln(os.Stderr, "suitetest:", err)
		return 2
	}
	gate.Lock()
	current = context
	gate.Unlock()
	code := m.Run()
	if err := context.WriteTrace(); err != nil {
		fmt.Fprintln(os.Stderr, "suitetest: the trace cannot be written:", err)
		if code == 0 {
			code = 1
		}
	}
	return code
}

// Suite is one suite's session as a TestSuite_<id> function drives it.
type Suite struct {
	session *exec.Session
}

// Open lints and opens one suite for a test, and registers its teardown with
// the test's cleanup, so it runs once after the last subtest. A suite that
// does not lint clean fails the test with its findings, and nothing runs.
func Open(t *testing.T, suitePath, schemaRoot string, guarded bool) *Suite {
	t.Helper()
	gate.Lock()
	context := current
	loaded := schemas[schemaRoot]
	gate.Unlock()
	if context == nil {
		t.Fatal("suitetest: no run has started; the generated TestMain calls suitetest.Main")
	}
	if loaded == nil {
		var err error
		if loaded, err = schema.Load(schemaRoot); err != nil {
			t.Fatal(err)
		}
		gate.Lock()
		schemas[schemaRoot] = loaded
		gate.Unlock()
	}
	findings, err := validate.File(suitePath, suitePath, loaded, &validate.Options{Extensions: context.Extensions.Composite})
	if err != nil {
		t.Fatal(err)
	}
	if findings = diag.Sorted(findings); diag.Fails(findings, false) {
		lines := []string{suitePath + " does not lint clean:"}
		for _, finding := range findings {
			lines = append(lines, finding.Human())
		}
		t.Fatal(strings.Join(lines, "\n"))
	}
	text, err := os.ReadFile(suitePath)
	if err != nil {
		t.Fatal(err)
	}
	document, err := model.Load(string(text))
	if err != nil {
		t.Fatal(err)
	}
	held, _ := document.Value.(*model.Map)
	session, err := exec.Open(suitePath, held, loaded, context, guarded)
	if err != nil {
		t.Fatal(err)
	}
	// The teardown runs once, on the setup's bag, after every subtest; a failed
	// teardown fails this test, never a subtest that passed (rule 6).
	t.Cleanup(func() {
		if result := session.Teardown(); result.Failed {
			t.Errorf("The suite teardown of %s failed: %s", session.Name, result.Message)
		}
	})
	return &Suite{session: session}
}

// Case is one case's subtest: beforeEach (the setup first, once), the case,
// and afterEach in the subtest's cleanup. A case that does not pass fails the
// subtest with its message; a skipped one (tag filter, guarded suite) skips it
// with its reason; a failed afterEach fails it too (rule 4).
func (held *Suite) Case(name string) func(*testing.T) {
	return func(t *testing.T) {
		t.Helper()
		index, err := held.session.IndexOf(name)
		if err != nil {
			t.Fatal(err)
		}
		if err := held.session.BeforeEach(index); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			result, err := held.session.AfterEach(index)
			if err != nil {
				t.Error(err)
				return
			}
			if result.AfterEachFailed {
				t.Error(result.Message)
			}
		})
		result, err := held.session.RunCase(index)
		if err != nil {
			t.Fatal(err)
		}
		switch result.Status {
		case trace.Passed:
		case trace.Skipped:
			t.Skip(result.Message)
		default:
			t.Error(result.Message)
		}
	}
}
