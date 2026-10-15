// E3, the Go part: an extension built outside the runtime, on its public API
// only, adds an action, a context key, an option and a rule; the plain runtime
// has none of them; two extensions cannot define one action.
package example_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/parser"
	"go/token"
	"os"
	osexec "os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/example"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/actions"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/suiterun"
)

const module = "github.com/smartpcr/bdd-code-extension/runtimes/go"

// The test runs from this package's folder, which is the example workspace.
var (
	schemaRoot = filepath.Join("schema")
	suite      = filepath.Join("suites", "echo.yml")
)

type outcome struct {
	code     int
	out, err string
}

func run(arguments []string, extensions ...extension.Extension) outcome {
	var out, err bytes.Buffer
	code := suiterun.Main(arguments, &out, &err, extensions...)
	return outcome{code, out.String(), err.String()}
}

func lint(t *testing.T, extensions ...extension.Extension) (int, []string) {
	t.Helper()
	got := run([]string{"lint", "--schema-root", schemaRoot, "--path", suite, "--json"}, extensions...)
	var findings []struct {
		Code   string `json:"code"`
		Line   int    `json:"line"`
		Column int    `json:"column"`
	}
	if err := json.Unmarshal([]byte(got.out), &findings); err != nil {
		t.Fatalf("lint printed %q (%v); stderr %q", got.out, err, got.err)
	}
	out := []string{}
	for _, one := range findings {
		out = append(out, fmt.Sprintf("%s %d:%d", one.Code, one.Line, one.Column))
	}
	return got.code, out
}

func TestWithTheExtensionTheActionRunsRegionReadsTheOptionAndTheRuleReportsItsCeiling(t *testing.T) {
	got := run([]string{"run", "--schema-root", schemaRoot, "--path", suite, "--region", "eu"}, example.Echo)
	if got.code != 0 {
		t.Fatalf("the run exited %d:\n%s\n%s", got.code, got.out, got.err)
	}
	// The suite asserts e.echoed equals 'eu:hello from eu': the action ran,
	// ${region} read the option, and the action saw its extension's state.
	if !strings.Contains(got.out, "[passed] echoes-with-the-region") {
		t.Errorf("the run said:\n%s", got.out)
	}
	code, findings := lint(t, example.Echo)
	if code != 2 || strings.Join(findings, ",") != "E205 5:17" {
		t.Errorf("lint exited %d with %v; only the rule (timeoutSec 30 in a suite tagged slow) was expected", code, findings)
	}
	listed := run([]string{"actions", "--json"}, example.Echo)
	var names []string
	if err := json.Unmarshal([]byte(listed.out), &names); err != nil || !contains(names, "example.echo") {
		t.Errorf("actions listed %q (%v)", listed.out, err)
	}
}

func TestWithoutTheExtensionRegionIsE301NoCeilingTheOptionIsRefusedAndTheActionHasNoHandler(t *testing.T) {
	// Lint follows the catalog, so example.echo is not E104; the context key is
	// unknown and the slow rule is not there.
	code, findings := lint(t)
	if code != 2 || strings.Join(findings, ",") != "E301 9:15" {
		t.Errorf("lint exited %d with %v; only E301 9:15 was expected", code, findings)
	}
	refused := run([]string{"run", "--schema-root", schemaRoot, "--path", suite, "--region", "eu"})
	if refused.code != 2 || !strings.Contains(refused.err, "run does not take --region") {
		t.Errorf("--region without the extension: %d %q", refused.code, refused.err)
	}
	results := filepath.Join(t.TempDir(), "results.xml")
	failed := run([]string{"run", "--schema-root", schemaRoot, "--path", suite, "--results", results, "--format", "junit"})
	if failed.code != 1 || !strings.Contains(failed.out, "[failed] echoes-with-the-region") {
		t.Errorf("the run without the extension exited %d:\n%s\n%s", failed.code, failed.out, failed.err)
	}
	written, err := os.ReadFile(results)
	if err != nil {
		t.Fatal(err)
	}
	// The step reads ${region} first, so without the context key it fails there.
	if !strings.Contains(string(written), "E301: ${region} resolves to nothing") {
		t.Errorf("the failure does not name the unknown context key:\n%s", written)
	}
	// The same step without ${region} reaches dispatch, and fails it by name.
	text, err := os.ReadFile(suite)
	if err != nil {
		t.Fatal(err)
	}
	plain := filepath.Join(t.TempDir(), "echo.yml")
	if err := os.WriteFile(plain, []byte(strings.Replace(string(text), "hello from ${region}", "hello", 1)), 0o600); err != nil {
		t.Fatal(err)
	}
	failed = run([]string{"run", "--schema-root", schemaRoot, "--path", plain, "--results", results, "--format", "junit"})
	written, _ = os.ReadFile(results)
	if failed.code != 1 || !strings.Contains(string(written), "Unknown action: example.echo. No extension of this runtime registers it.") {
		t.Errorf("an unregistered action exited %d:\n%s", failed.code, written)
	}
}

func TestTheSlowRuleCapsACaseAtRunTime(t *testing.T) {
	limit := example.Echo.Rules.CaseLimitSec
	slow := mapOf(t, "tags: [slow]\n")
	if limit(slow, 30) != example.SlowCeilingSec || limit(slow, 5) != 5 || limit(mapOf(t, "tags: [fast]\n"), 30) != 30 {
		t.Error("the run-time ceiling")
	}
}

func TestTwoExtensionsDefiningOneActionAreRefusedBeforeAnythingRuns(t *testing.T) {
	twin := extension.Extension{
		Name:    "twin",
		Actions: []actions.Registration{{Name: "example.echo", Handler: func(*actions.Request) (any, error) { return nil, nil }}},
	}
	got := run([]string{"actions"}, example.Echo, twin)
	if got.code != 2 || got.out != "" {
		t.Errorf("it exited %d and printed %q", got.code, got.out)
	}
	if !strings.Contains(got.err, "Action example.echo is defined by both example and twin.") {
		t.Errorf("it said %q", got.err)
	}
}

func TestTheExampleIsItsOwnProgramAndImportsOnlyPublicPackages(t *testing.T) {
	program := filepath.Join(t.TempDir(), "suiterun-example")
	if runtime.GOOS == "windows" {
		program += ".exe"
	}
	build := osexec.Command("go", "build", "-o", program, "./cmd/suiterun")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("the example does not build: %v\n%s", err, out)
	}
	ran := osexec.Command(program, "run", "--schema-root", schemaRoot, "--path", suite, "--region", "eu")
	if out, err := ran.CombinedOutput(); err != nil {
		t.Fatalf("the example program failed: %v\n%s", err, out)
	}

	files := []string{}
	for _, directory := range []string{".", filepath.Join("cmd", "suiterun")} {
		found, err := filepath.Glob(filepath.Join(directory, "*.go"))
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, found...)
	}
	checked := 0
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), file, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, spec := range parsed.Imports {
			path, _ := strconv.Unquote(spec.Path.Value)
			public := path == module+"/example" || strings.HasPrefix(path, module+"/suite/")
			standard := !strings.Contains(strings.SplitN(path, "/", 2)[0], ".")
			if !public && !standard {
				t.Errorf("%s imports %s, which is not a public package of the runtime", file, path)
			}
		}
		checked++
	}
	if checked != 2 {
		t.Errorf("%d source files were checked, not 2", checked)
	}
}

func contains(names []string, wanted string) bool {
	for _, name := range names {
		if name == wanted {
			return true
		}
	}
	return false
}

func mapOf(t *testing.T, text string) *model.Map {
	t.Helper()
	document, err := model.Load(text)
	if err != nil {
		t.Fatal(err)
	}
	held, _ := document.Value.(*model.Map)
	return held
}
