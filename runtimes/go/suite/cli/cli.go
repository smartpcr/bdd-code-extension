// Package cli parses the command line every runtime shares.
//
// DEC-Y14 gives every runtime the same verbs:
//
//	suiterun lint    --path <glob> [--json] [--strict] [--binding-check] [--binding <name>]
//	suiterun run     --path <glob> [--tags a,b] [--results f.xml] [--format nunit3|junit]
//	                 [--dry-run] [--param name=value] [--trace-file f.json]
//	                 [any option an extension declares, with its value]
//	suiterun list    --path <glob> [--tags a,b]
//	suiterun actions [--json]
//
// Parsed by hand rather than with the flag package, because the exit codes are
// part of the contract: an unknown argument is 2, and flag's own error handling
// exits 2 with its own message and no verb in it.
//
// An extension's options (extension.Option) are taken like the core's valued
// flags; without the extension that declares one, it is refused as unknown.
package cli

import (
	"fmt"
	"strings"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
)

// Verb is what the tool was asked to do.
type Verb string

const (
	Lint    Verb = "lint"
	Run     Verb = "run"
	List    Verb = "list"
	Actions Verb = "actions"
	// Generate writes go test code from a test project's suites (spec/test-plan.md).
	Generate Verb = "generate"
)

// ReportFormat is which report a run writes.
type ReportFormat string

const (
	NUnit3 ReportFormat = "nunit3"
	JUnit  ReportFormat = "junit"
)

// The three exit codes every binding shares.
const (
	// ExitPassed means every selected case passed, or the validation found
	// nothing.
	ExitPassed = 0
	// ExitFailed means a case failed. Only a run can produce this.
	ExitFailed = 1
	// ExitRefused means a validation error, or the harness could not do its job
	// at all.
	ExitRefused = 2
)

// Options is one parsed command line.
type Options struct {
	Verb         Verb
	Path         string
	Tags         []string
	Results      string
	TraceFile    string
	Format       ReportFormat
	Params       [][2]string
	Binding      string
	JSON         bool
	Strict       bool
	DryRun       bool
	BindingCheck bool
	SchemaRoot   string
	// ExtensionOptions is the value given for each option an extension
	// declares, by flag.
	ExtensionOptions map[string]string
	// Configs, Plan, Check, Provider and Out are generate's: the
	// bddsuite.tests.yaml files, print the plan, only say what is stale, the
	// provider, and the folder written to.
	Configs  []string
	Plan     bool
	Check    bool
	Provider string
	Out      string
}

// Usage is the text a refusal prints beside its own message.
const Usage = `suiterun lint    --path <glob> [--json] [--strict] [--binding-check] [--binding <name>]
suiterun run     --path <glob> [--tags a,b] [--results f.xml] [--format nunit3|junit]
                 [--dry-run] [--param name=value] [--trace-file f.json]
suiterun list    --path <glob> [--tags a,b]
suiterun actions [--json]
suiterun generate --config <bddsuite.tests.yaml> [--provider go] [--out <folder>] [--plan | --check]`

// UsageWith is the usage text with every option the extensions declare.
func UsageWith(declared []extension.Option) string {
	if len(declared) == 0 {
		return Usage
	}
	lines := []string{Usage, "Options the extensions add, for run:"}
	for _, option := range declared {
		lines = append(lines, fmt.Sprintf("                 %s <value>  %s", option.Flag, option.Description))
	}
	return strings.Join(lines, "\n")
}

// Parse reads one command line, or says why it cannot be read. declared is
// every option the extensions add (Composite.Options); each takes a value.
func Parse(arguments []string, declared ...extension.Option) (Options, error) {
	Usage := UsageWith(declared)
	extensionFlags := map[string]bool{}
	for _, option := range declared {
		extensionFlags[option.Flag] = true
	}
	options := Options{Format: NUnit3, Binding: "go", ExtensionOptions: map[string]string{}}
	if len(arguments) == 0 {
		return options, fmt.Errorf("a verb is needed.\n%s", Usage)
	}
	switch Verb(arguments[0]) {
	case Lint, Run, List, Actions, Generate:
		options.Verb = Verb(arguments[0])
	default:
		return options, fmt.Errorf("there is no verb called %s.\n%s", arguments[0], Usage)
	}

	index := 1
	// Every flag that takes a value reads the next argument, and says so rather
	// than silently treating the next flag as its value.
	value := func(name string) (string, error) {
		index++
		if index >= len(arguments) || strings.HasPrefix(arguments[index], "--") {
			return "", fmt.Errorf("%s needs a value after it", name)
		}
		return arguments[index], nil
	}
	for ; index < len(arguments); index++ {
		name := arguments[index]
		var found string
		var err error
		switch name {
		case "--path":
			found, err = value(name)
			options.Path = found
		case "--tags":
			found, err = value(name)
			for _, tag := range strings.Split(found, ",") {
				if trimmed := strings.TrimSpace(tag); trimmed != "" {
					options.Tags = append(options.Tags, trimmed)
				}
			}
		case "--results":
			found, err = value(name)
			options.Results = found
		case "--trace-file":
			found, err = value(name)
			options.TraceFile = found
		case "--schema-root":
			found, err = value(name)
			options.SchemaRoot = found
		case "--binding":
			found, err = value(name)
			options.Binding = found
		case "--format":
			found, err = value(name)
			switch ReportFormat(found) {
			case NUnit3, JUnit:
				options.Format = ReportFormat(found)
			default:
				if err == nil {
					err = fmt.Errorf("--format is nunit3 or junit, not %s", found)
				}
			}
		case "--param":
			found, err = value(name)
			if err == nil {
				at := strings.Index(found, "=")
				if at <= 0 {
					err = fmt.Errorf("--param takes name=value, and %s is not one", found)
				} else {
					options.Params = append(options.Params, [2]string{found[:at], found[at+1:]})
				}
			}
		case "--config":
			found, err = value(name)
			options.Configs = append(options.Configs, found)
		case "--plan":
			options.Plan = true
		case "--check":
			options.Check = true
		case "--provider":
			found, err = value(name)
			options.Provider = found
		case "--out":
			found, err = value(name)
			options.Out = found
		case "--json":
			options.JSON = true
		case "--strict":
			options.Strict = true
		case "--dry-run":
			options.DryRun = true
		case "--binding-check":
			options.BindingCheck = true
		default:
			if !extensionFlags[name] {
				return options, fmt.Errorf("%s does not take %s.\n%s", options.Verb, name, Usage)
			}
			found, err = value(name)
			if err == nil {
				options.ExtensionOptions[name] = found
			}
		}
		if err != nil {
			return options, err
		}
	}

	// A verb that reads files needs to be told which. `actions` reads the
	// catalog and nothing else, so it is the one that does not.
	if options.Verb == Generate {
		if len(options.Configs) == 0 {
			return options, fmt.Errorf("generate needs --config.\n%s", Usage)
		}
		if options.Plan && options.Check {
			return options, fmt.Errorf("generate takes --plan or --check, not both")
		}
		return options, nil
	}
	if len(options.Configs) > 0 || options.Plan || options.Check || options.Provider != "" || options.Out != "" {
		return options, fmt.Errorf("%s does not take generate's flags.\n%s", options.Verb, Usage)
	}
	if options.Verb != Actions && options.Path == "" {
		return options, fmt.Errorf("%s needs --path.\n%s", options.Verb, Usage)
	}
	return options, nil
}
