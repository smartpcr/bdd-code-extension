package run

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/where"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/actions"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/cli"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
)

// options parses a command line; lint and run read the corpus's schema, which
// no directory walk finds, so they are given --schema-root.
func options(t *testing.T, line string) cli.Options {
	t.Helper()
	fields := strings.Fields(line)
	if len(fields) > 0 && (fields[0] == "lint" || fields[0] == "run") && !strings.Contains(line, "--schema-root") {
		fields = append(fields, "--schema-root", where.CorpusSchema())
	}
	parsed, err := cli.Parse(fields)
	if err != nil {
		t.Fatalf("%s: %v", line, err)
	}
	return parsed
}

// corpus is one fixture by its path under conformance/.
func corpus(t *testing.T, relative string) string {
	t.Helper()
	return filepath.Join(where.Corpus(), filepath.FromSlash(relative))
}

// corpusExecute is the verbs with the corpus's extension, as the corpus is run.
func corpusExecute(options cli.Options) Report {
	return Execute(options, where.CorpusComposite())
}

func TestActionsListsWhatThisBindingImplements(t *testing.T) {
	report := corpusExecute(options(t, "actions"))
	if report.Code != cli.ExitPassed {
		t.Fatalf("it exited %d: %s", report.Code, report.Errors)
	}
	// The core, wait, and the corpus extension's fixture.append and fixture.throw.
	if report.Out != "core.fail\ncore.noop\ncore.record\ncore.set\ncore.skip\ncore.sleep\nfixture.append\nfixture.throw\nwait" {
		t.Errorf("it listed:\n%s", report.Out)
	}
	asJSON := corpusExecute(options(t, "actions --json"))
	if !strings.HasPrefix(strings.TrimSpace(asJSON.Out), "[") {
		t.Errorf("the JSON form is:\n%s", asJSON.Out)
	}
}

func TestLintIsCleanOnACorpusSuiteThatIs(t *testing.T) {
	report := corpusExecute(options(t, "lint --path "+corpus(t, "execute/hooks.yml")))
	if report.Code != cli.ExitPassed {
		t.Fatalf("it exited %d:\n%s\n%s", report.Code, report.Out, report.Errors)
	}
	if !strings.Contains(report.Out, "Lint clean") {
		t.Errorf("it said:\n%s", report.Out)
	}
}

func TestLintRefusesAFileThatDoesNotValidate(t *testing.T) {
	report := corpusExecute(options(t, "lint --path "+corpus(t, "validate/typos.yml")))
	if report.Code != cli.ExitRefused {
		t.Fatalf("it exited %d:\n%s", report.Code, report.Out)
	}
	if !strings.Contains(report.Out, "E101") {
		t.Errorf("it said:\n%s", report.Out)
	}
	asJSON := corpusExecute(options(t, "lint --json --path "+corpus(t, "validate/typos.yml")))
	if !strings.Contains(asJSON.Out, `"code": "E101"`) {
		t.Errorf("the JSON form is:\n%s", asJSON.Out)
	}
}

func TestAPathThatNamesNothingIsAHarnessError(t *testing.T) {
	report := corpusExecute(options(t, "lint --path nosuchfile.yml"))
	if report.Code != cli.ExitRefused {
		t.Fatalf("it exited %d", report.Code)
	}
	if !strings.Contains(report.Errors, "names no file") {
		t.Errorf("it said %q", report.Errors)
	}
	if corpusExecute(options(t, "run --path nosuchfile.yml")).Code != cli.ExitRefused {
		t.Error("a run of nothing did not refuse")
	}
	if corpusExecute(options(t, "list --path nosuchfile.yml")).Code != cli.ExitRefused {
		t.Error("a list of nothing did not refuse")
	}
}

func TestListNamesTheCasesARunWouldSelect(t *testing.T) {
	report := corpusExecute(options(t, "list --path "+corpus(t, "execute/tags.yml")))
	if report.Code != cli.ExitPassed {
		t.Fatalf("it exited %d: %s", report.Code, report.Errors)
	}
	if !strings.Contains(report.Out, "the-selected-one") || !strings.Contains(report.Out, "the-unselected-one") {
		t.Errorf("it listed:\n%s", report.Out)
	}
	filtered := corpusExecute(options(t, "list --tags wanted --path "+corpus(t, "execute/tags.yml")))
	if !strings.Contains(filtered.Out, "the-selected-one") {
		t.Errorf("the filtered list is:\n%s", filtered.Out)
	}
	if strings.Contains(filtered.Out, "the-unselected-one") {
		t.Errorf("the filter selected too much:\n%s", filtered.Out)
	}
}

func TestARunThatPassesExitsZeroAndOneThatFailsExitsOne(t *testing.T) {
	passed := corpusExecute(options(t, "run --path "+corpus(t, "execute/hooks.yml")))
	if passed.Code != cli.ExitPassed {
		t.Errorf("a passing run exited %d:\n%s", passed.Code, passed.Out)
	}
	failed := corpusExecute(options(t, "run --path "+corpus(t, "execute/gherkin.yml")))
	if failed.Code != cli.ExitFailed {
		t.Errorf("a failing run exited %d:\n%s", failed.Code, failed.Out)
	}
	if !strings.Contains(failed.Out, "One or more tests failed") {
		t.Errorf("it said:\n%s", failed.Out)
	}
}

func TestARunWritesTheTraceAndTheResultsItWasAskedFor(t *testing.T) {
	scratch := t.TempDir()
	tracePath := filepath.Join(scratch, "nested", "trace.json")
	resultsPath := filepath.Join(scratch, "results.xml")
	report := corpusExecute(options(t, strings.Join([]string{
		"run --path", corpus(t, "execute/hooks.yml"),
		"--trace-file", tracePath,
		"--results", resultsPath,
	}, " ")))
	if report.Code != cli.ExitPassed {
		t.Fatalf("it exited %d:\n%s\n%s", report.Code, report.Out, report.Errors)
	}
	written, err := os.ReadFile(tracePath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(written), `"phase"`) {
		t.Errorf("the trace holds %q", written)
	}
	results, err := os.ReadFile(resultsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(results), "<test-run") {
		t.Errorf("the results hold %q", results)
	}
	// The JUnit form is the same run written the other way.
	junitPath := filepath.Join(scratch, "results-junit.xml")
	corpusExecute(options(t, strings.Join([]string{
		"run --path", corpus(t, "execute/hooks.yml"),
		"--results", junitPath, "--format", "junit",
	}, " ")))
	junit, err := os.ReadFile(junitPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(junit), "<testsuites>") {
		t.Errorf("the JUnit results hold %q", junit)
	}
}

func TestADryRunValidatesAndRunsNothing(t *testing.T) {
	report := corpusExecute(options(t, "run --dry-run --path "+corpus(t, "execute/hooks.yml")))
	if report.Code != cli.ExitPassed {
		t.Fatalf("it exited %d:\n%s", report.Code, report.Out)
	}
	if !strings.Contains(report.Out, "live tests were not run") {
		t.Errorf("it said:\n%s", report.Out)
	}
}

func TestAFileThatIsNotYamlIsAHarnessErrorForEveryVerbThatReadsIt(t *testing.T) {
	broken := corpus(t, "validate/broken.yml")
	for _, verb := range []string{"run", "list"} {
		report := corpusExecute(options(t, verb+" --path "+broken))
		if report.Code != cli.ExitRefused {
			t.Errorf("%s exited %d", verb, report.Code)
		}
		if !strings.Contains(report.Errors, "not valid YAML") {
			t.Errorf("%s said %q", verb, report.Errors)
		}
	}
}

func TestAVerbNobodyImplementsIsRefused(t *testing.T) {
	if corpusExecute(cli.Options{Verb: "nosuch"}).Code != cli.ExitRefused {
		t.Error("an unknown verb was run")
	}
}

// The workspace root and the schema root: --schema-root needs no walk, and
// without it a directory with no test/e2e/schema above it is refused.
func TestTheRootsNeedNoWalkWithASchemaRoot(t *testing.T) {
	alone := t.TempDir()
	root, schemaRoot, err := Roots(cli.Options{SchemaRoot: "schema"}, alone)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(root, alone) || !strings.EqualFold(schemaRoot, filepath.Join(alone, "schema")) {
		t.Errorf("with --schema-root the roots are %s and %s", root, schemaRoot)
	}
	if _, schemaRoot, _ := Roots(cli.Options{SchemaRoot: where.CorpusSchema()}, alone); schemaRoot != where.CorpusSchema() {
		t.Errorf("an absolute --schema-root became %s", schemaRoot)
	}
	_, _, err = Roots(cli.Options{}, alone)
	if err == nil || err.Error() != "the workspace root cannot be found from this directory (no test/e2e/schema above it); pass --schema-root." {
		t.Skipf("the temporary directory sits inside a workspace on this machine: %v", err)
	}
	workspace := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workspace, "test", "e2e", "schema"), 0o755); err != nil {
		t.Fatal(err)
	}
	root, schemaRoot, err = Roots(cli.Options{}, workspace)
	if err != nil || !strings.EqualFold(root, workspace) || schemaRoot != filepath.Join(workspace, "test", "e2e", "schema") {
		t.Errorf("in a workspace the roots are %s and %s (%v)", root, schemaRoot, err)
	}
	// With --schema-root inside a workspace, findings stay relative to it.
	root, _, _ = Roots(cli.Options{SchemaRoot: "elsewhere"}, workspace)
	if !strings.EqualFold(root, workspace) {
		t.Errorf("the workspace root with --schema-root is %s", root)
	}
}

func TestLintAndRunWithoutASchemaRootOrAWorkspaceAreRefused(t *testing.T) {
	working, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := Roots(cli.Options{}, working); err == nil {
		t.Skip("a workspace is above this package on this machine")
	}
	for _, verb := range []string{"lint", "run"} {
		parsed, err := cli.Parse([]string{verb, "--path", corpus(t, "execute/hooks.yml")})
		if err != nil {
			t.Fatal(err)
		}
		report := Execute(parsed, nil)
		if report.Code != cli.ExitRefused || !strings.Contains(report.Errors, "pass --schema-root") {
			t.Errorf("%s without --schema-root: %d %q", verb, report.Code, report.Errors)
		}
	}
}

// The actions verb lists every extension's actions with the core's.
func TestActionsListsTheExtensionsActions(t *testing.T) {
	composite, err := extension.Compose(extension.Extension{
		Name:    "probe",
		Actions: []actions.Registration{{Name: "probe.read", Handler: func(*actions.Request) (any, error) { return nil, nil }}},
	})
	if err != nil {
		t.Fatal(err)
	}
	report := Execute(options(t, "actions --json"), composite)
	if !strings.Contains(report.Out, `"probe.read"`) || !strings.Contains(report.Out, `"wait"`) {
		t.Errorf("it listed:\n%s", report.Out)
	}
}

// The record path is read from <prefix>RECORD_PATH, the prefix being the
// composite's: BDD_SUITE_ by default, an extension's when it sets one.
func TestTheRecordPathIsReadUnderTheCompositesPrefix(t *testing.T) {
	for _, row := range []struct {
		prefix string
		set    string
	}{{"", "BDD_SUITE_RECORD_PATH"}, {"ACME_", "ACME_RECORD_PATH"}} {
		path := filepath.Join(t.TempDir(), "markers.txt")
		t.Setenv(row.set, path)
		suite := filepath.Join(t.TempDir(), "record.yml")
		text := "suite: record\ntests:\n  - name: records\n    steps:\n      - action: core.record\n        marker: here\n"
		if err := os.WriteFile(suite, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
		composite, err := extension.Compose(extension.Extension{Name: "prefix", EnvPrefix: row.prefix})
		if err != nil {
			t.Fatal(err)
		}
		report := Execute(options(t, "run --path "+suite), composite)
		if report.Code != cli.ExitPassed {
			t.Fatalf("it exited %d:\n%s\n%s", report.Code, report.Out, report.Errors)
		}
		written, err := os.ReadFile(path)
		if err != nil || strings.TrimSpace(string(written)) != "here" {
			t.Errorf("with %s the marker file holds %q (%v)", row.set, written, err)
		}
	}
}

// A run's reports pass every text through the extensions' redaction.
func TestAReportIsRedactedByTheExtensions(t *testing.T) {
	suite := filepath.Join(t.TempDir(), "secret.yml")
	text := "suite: secret\ntests:\n  - name: leaks\n    steps:\n      - action: core.fail\n        message: the token is s3cret\n"
	if err := os.WriteFile(suite, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	composite, err := extension.Compose(extension.Extension{
		Name: "redactor",
		Start: func(map[string]string) extension.RunState {
			return extension.RunState{Redact: func(text string) string { return strings.ReplaceAll(text, "s3cret", "***") }}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, format := range []string{"nunit3", "junit"} {
		results := filepath.Join(t.TempDir(), "results.xml")
		report := Execute(options(t, "run --path "+suite+" --results "+results+" --format "+format), composite)
		if report.Code != cli.ExitFailed {
			t.Fatalf("it exited %d: %s", report.Code, report.Errors)
		}
		written, err := os.ReadFile(results)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(written), "s3cret") || !strings.Contains(string(written), "the token is ***") {
			t.Errorf("the %s report holds:\n%s", format, written)
		}
	}
}
