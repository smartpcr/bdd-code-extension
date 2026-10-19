// Package run is the four verbs, and the exit code each of them leaves.
//
// Kept out of main so that the conformance tests drive exactly what the command
// line drives. A test that exercised a different path would prove the wrong
// thing.
//
// Every verb takes the runtime's composite (package extension): the core and
// every extension a consumer's suiterun was built with. A nil composite is the
// core alone.
package run

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/paths"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/report"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/suite"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/validate"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/cli"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/diag"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/exec"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/schema"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/trace"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

// Report is what a verb produced: what to print, and the code to exit with.
type Report struct {
	Out    string
	Errors string
	Code   int
}

func refused(message string) Report {
	return Report{Errors: message, Code: cli.ExitRefused}
}

func orCore(composite *extension.Composite) *extension.Composite {
	if composite == nil {
		return extension.CoreOnly()
	}
	return composite
}

// Roots is the workspace root (found from the working directory) and the
// schema root this run reads from.
//
// With --schema-root no walk is needed: findings are then relative to the
// workspace root when there is one, else to the working directory. Without it,
// the workspace root is the nearest ancestor holding test/e2e/schema, the
// layout a workspace uses by default.
func Roots(options cli.Options, working string) (string, string, error) {
	root, found := paths.RepositoryRoot(working)
	if options.SchemaRoot != "" {
		if !found {
			absolute, err := filepath.Abs(working)
			if err != nil {
				return "", "", err
			}
			root = absolute
		}
		schemaRoot := options.SchemaRoot
		if !filepath.IsAbs(schemaRoot) {
			schemaRoot = filepath.Join(working, schemaRoot)
		}
		return root, schemaRoot, nil
	}
	if !found {
		return "", "", fmt.Errorf("the workspace root cannot be found from this directory (no test/e2e/schema above it); pass --schema-root.")
	}
	return root, paths.SchemaRoot(root), nil
}

func roots(options cli.Options) (string, string, error) {
	working, err := os.Getwd()
	if err != nil {
		return "", "", err
	}
	return Roots(options, working)
}

func selectedFiles(options cli.Options) ([]string, error) {
	working, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	return paths.Resolve(options.Path, working)
}

func loadSuite(path string) (*model.Map, error) {
	text, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("%s cannot be read: %w", path, err)
	}
	document, err := model.Load(string(text))
	if err != nil {
		return nil, fmt.Errorf("%s is not valid YAML: %w", path, err)
	}
	held, ok := document.Value.(*model.Map)
	if !ok {
		return nil, fmt.Errorf("%s does not hold a YAML mapping.", path)
	}
	return held, nil
}

// Lint validates every selected suite and runs nothing.
func Lint(options cli.Options, composite *extension.Composite) Report {
	repository, schemaRoot, err := roots(options)
	if err != nil {
		return refused(err.Error())
	}
	loaded, err := schema.Load(schemaRoot)
	if err != nil {
		return refused(err.Error())
	}
	files, err := selectedFiles(options)
	if err != nil {
		return refused(err.Error())
	}

	found := []diag.Diagnostic{}
	settings := &validate.Options{
		Binding:      options.Binding,
		BindingCheck: options.BindingCheck,
		Params:       options.Params,
		Extensions:   orCore(composite),
	}
	for _, path := range files {
		relative := diag.RelativePath(path, repository)
		findings, err := validate.File(path, relative, loaded, settings)
		if err != nil {
			return refused(err.Error())
		}
		found = append(found, findings...)
	}
	found = diag.Sorted(found)

	fails := diag.Fails(found, options.Strict)
	out := ""
	if options.JSON {
		out = diag.JSONArray(found)
	} else {
		lines := make([]string, 0, len(found)+1)
		for _, finding := range found {
			lines = append(lines, finding.Human())
		}
		state := "clean"
		if fails {
			state = "failed"
		}
		lines = append(lines, fmt.Sprintf("Lint %s: %d suite file(s), %d finding(s).",
			state, len(files), len(found)))
		out = strings.Join(lines, "\n")
	}
	code := cli.ExitPassed
	if fails {
		code = cli.ExitRefused
	}
	return Report{Out: out, Code: code}
}

// List names the cases a run would select, and nothing else.
func List(options cli.Options) Report {
	files, err := selectedFiles(options)
	if err != nil {
		return refused(err.Error())
	}
	lines := []string{}
	for _, path := range files {
		held, err := loadSuite(path)
		if err != nil {
			return refused(err.Error())
		}
		for _, one := range suite.Cases(held) {
			if !suite.TagsMatch(suite.CaseTags(held, one), options.Tags) {
				continue
			}
			lines = append(lines, fmt.Sprintf("%s  %s", filepath.Base(path), walk.Text(one, "name")))
		}
	}
	return Report{Out: strings.Join(lines, "\n"), Code: cli.ExitPassed}
}

// Actions says what this runtime implements (the core's, wait and every
// extension's), which is what a portability check is answered from.
func Actions(options cli.Options, composite *extension.Composite) Report {
	names := exec.AllNames(orCore(composite))
	if options.JSON {
		items := make([]any, 0, len(names))
		for _, name := range names {
			items = append(items, name)
		}
		text, err := json.MarshalIndent(items, "", "  ")
		if err != nil {
			return refused(err.Error())
		}
		return Report{Out: string(text), Code: cli.ExitPassed}
	}
	return Report{Out: strings.Join(names, "\n"), Code: cli.ExitPassed}
}

// Run executes every selected case.
func Run(options cli.Options, composite *extension.Composite) Report {
	composite = orCore(composite)
	_, schemaRoot, err := roots(options)
	if err != nil {
		return refused(err.Error())
	}
	loaded, err := schema.Load(schemaRoot)
	if err != nil {
		return refused(err.Error())
	}
	files, err := selectedFiles(options)
	if err != nil {
		return refused(err.Error())
	}

	recorded := &trace.Trace{}
	settings := &exec.Options{
		Tags:       options.Tags,
		Params:     options.Params,
		DryRun:     options.DryRun,
		RecordPath: os.Getenv(composite.EnvPrefix + "RECORD_PATH"),
	}
	// Once per run, shared by every file, so an extension's state persists
	// across files.
	extensions := &exec.RunExtensions{
		Composite: composite,
		Started:   extension.Start(composite, options.ExtensionOptions),
	}

	suites := []exec.SuiteResult{}
	lines := []string{}
	for _, path := range files {
		held, err := loadSuite(path)
		if err != nil {
			return refused(err.Error())
		}
		result, err := exec.RunFile(path, held, loaded, settings, extensions, recorded)
		if err != nil {
			return refused(err.Error())
		}
		lines = append(lines, fmt.Sprintf("=== Suite: %s ===", filepath.Base(path)))
		for _, one := range result.Cases {
			lines = append(lines, fmt.Sprintf("  [%-5s] %s", one.Status, one.Name))
		}
		suites = append(suites, result)
	}

	result := &exec.RunResult{Suites: suites, Trace: recorded}
	failed := exec.Failed(result)

	if options.TraceFile != "" {
		text, err := json.MarshalIndent(recorded.JSON(), "", "  ")
		if err != nil {
			return refused(err.Error())
		}
		if err := write(options.TraceFile, string(text)+"\n"); err != nil {
			return refused(err.Error())
		}
		lines = append(lines, "Trace written to "+options.TraceFile)
	}
	if options.Results != "" {
		// Every text a report carries passes through the extensions' redaction.
		document := report.NUnit3(suites, extensions.Started.Redact)
		if options.Format == cli.JUnit {
			document = report.JUnit(suites, extensions.Started.Redact)
		}
		if err := write(options.Results, document); err != nil {
			return refused(err.Error())
		}
		lines = append(lines, "Results written to "+options.Results)
	}
	switch {
	case failed:
		lines = append(lines, "One or more tests failed.")
	case options.DryRun:
		lines = append(lines, "Suite validation passed; live tests were not run.")
	default:
		lines = append(lines, "All selected tests passed.")
	}

	code := cli.ExitPassed
	if failed {
		code = cli.ExitFailed
	}
	return Report{Out: strings.Join(lines, "\n"), Code: code}
}

func write(path, text string) error {
	if parent := filepath.Dir(path); parent != "" && parent != "." {
		if err := os.MkdirAll(parent, 0o755); err != nil {
			return fmt.Errorf("%s cannot be written: %w", path, err)
		}
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		return fmt.Errorf("%s cannot be written: %w", path, err)
	}
	return nil
}

// Execute does one command line with the given composite (nil for the core
// alone).
func Execute(options cli.Options, composite *extension.Composite) Report {
	switch options.Verb {
	case cli.Lint:
		return Lint(options, composite)
	case cli.Run:
		return Run(options, composite)
	case cli.List:
		return List(options)
	case cli.Actions:
		return Actions(options, composite)
	case cli.Generate:
		return Generate(options)
	default:
		return refused(string(options.Verb) + " is not a verb.")
	}
}
