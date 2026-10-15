package cli

import (
	"strings"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
)

func args(line string) []string {
	if strings.TrimSpace(line) == "" {
		return nil
	}
	return strings.Fields(line)
}

func TestEveryVerbParses(t *testing.T) {
	for _, want := range []Verb{Lint, Run, List} {
		options, err := Parse(args(string(want) + " --path a.yml"))
		if err != nil {
			t.Fatalf("%s: %v", want, err)
		}
		if options.Verb != want {
			t.Errorf("%s parsed as %s", want, options.Verb)
		}
	}
	options, err := Parse(args("actions"))
	if err != nil || options.Verb != Actions {
		t.Errorf("actions: %v %s", err, options.Verb)
	}
}

func TestFlagsAreRead(t *testing.T) {
	options, err := Parse(args(
		"run --path t/*.yml --tags a,b --results r.xml --format junit --dry-run " +
			"--param one=1 --param two=x=y --trace-file t.json --schema-root s"))
	if err != nil {
		t.Fatal(err)
	}
	if options.Path != "t/*.yml" {
		t.Errorf("path %q", options.Path)
	}
	if len(options.Tags) != 2 || options.Tags[0] != "a" || options.Tags[1] != "b" {
		t.Errorf("tags %v", options.Tags)
	}
	if options.Results != "r.xml" || options.TraceFile != "t.json" {
		t.Errorf("results %q trace %q", options.Results, options.TraceFile)
	}
	if options.Format != JUnit || !options.DryRun {
		t.Errorf("format %q dryRun %v", options.Format, options.DryRun)
	}
	if len(options.Params) != 2 || options.Params[1] != [2]string{"two", "x=y"} {
		t.Errorf("params %v", options.Params)
	}
	if options.SchemaRoot != "s" || len(options.ExtensionOptions) != 0 {
		t.Errorf("schema root %q, extension options %v", options.SchemaRoot, options.ExtensionOptions)
	}
}

// An extension's option is a valued flag like the core's; without the
// extension that declares it, it is an unknown flag. The core has no lab
// options of its own any more: --api-url is refused unless an extension adds it.
func TestAnExtensionsOptionIsAValuedFlagOnlyWithTheExtension(t *testing.T) {
	declared := []extension.Option{{Flag: "--api-url", Description: "Where the API is."}}
	options, err := Parse(args("run --path a.yml --api-url http://api/api/v1"), declared...)
	if err != nil {
		t.Fatal(err)
	}
	if options.ExtensionOptions["--api-url"] != "http://api/api/v1" {
		t.Errorf("extension options %v", options.ExtensionOptions)
	}
	if _, err := Parse(args("run --path a.yml --api-url"), declared...); err == nil ||
		!strings.Contains(err.Error(), "--api-url needs a value") {
		t.Errorf("a valueless extension option said %v", err)
	}
	for _, flag := range []string{"--api-url", "--lab-id", "--connection-file"} {
		_, err := Parse(args("run --path a.yml " + flag + " x"))
		if err == nil || !strings.Contains(err.Error(), "run does not take "+flag) {
			t.Errorf("%s without an extension said %v", flag, err)
		}
	}
	if strings.Contains(Usage, "--api-url") || strings.Contains(Usage, "--lab-id") {
		t.Error("the core usage names a lab option")
	}
	if usage := UsageWith(declared); !strings.Contains(usage, "--api-url <value>  Where the API is.") {
		t.Errorf("the usage with the extension is %q", usage)
	}
	if UsageWith(nil) != Usage {
		t.Error("the usage with no extension option differs from Usage")
	}
}

func TestLintFlagsAreRead(t *testing.T) {
	options, err := Parse(args("lint --path a.yml --json --strict --binding-check --binding rust"))
	if err != nil {
		t.Fatal(err)
	}
	if !options.JSON || !options.Strict || !options.BindingCheck {
		t.Errorf("flags %+v", options)
	}
	if options.Binding != "rust" {
		t.Errorf("binding %q", options.Binding)
	}
}

func TestTheBindingDefaultsToThisOne(t *testing.T) {
	options, _ := Parse(args("lint --path a.yml"))
	if options.Binding != "go" {
		t.Errorf("binding %q", options.Binding)
	}
	if options.Format != NUnit3 {
		t.Errorf("format %q", options.Format)
	}
}

func TestRefusals(t *testing.T) {
	for _, row := range []struct{ line, contains string }{
		{"", "a verb is needed"},
		{"frobnicate --path a.yml", "frobnicate"},
		{"run --path a.yml --nonsense", "--nonsense"},
		{"run --path", "--path needs a value"},
		{"run --path a.yml --tags", "--tags needs a value"},
		{"run --path --json", "--path needs a value"},
		{"run --path a.yml --format xml", "nunit3 or junit"},
		{"run --path a.yml --param lonely", "name=value"},
		{"run --path a.yml --param =x", "name=value"},
		{"lint", "needs --path"},
		{"run", "needs --path"},
		{"list", "needs --path"},
	} {
		_, err := Parse(args(row.line))
		if err == nil {
			t.Errorf("[%s] was accepted", row.line)
			continue
		}
		if !strings.Contains(err.Error(), row.contains) {
			t.Errorf("[%s] said %q, wanted %q in it", row.line, err, row.contains)
		}
	}
}

func TestActionsNeedsNoPath(t *testing.T) {
	if _, err := Parse(args("actions")); err != nil {
		t.Errorf("actions needs no path: %v", err)
	}
	options, err := Parse(args("actions --json"))
	if err != nil || !options.JSON {
		t.Errorf("actions --json: %v %+v", err, options)
	}
}

func TestUsageNamesEveryVerb(t *testing.T) {
	for _, verb := range []string{"lint", "run", "list", "actions"} {
		if !strings.Contains(Usage, verb) {
			t.Errorf("the usage text does not name %s", verb)
		}
	}
}
