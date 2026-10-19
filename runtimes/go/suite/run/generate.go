package run

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/cli"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/generate"
)

// Generate is `generate`: build each config's test plan and write the go test
// code (spec/test-plan.md). With --plan it prints the one config's plan; with
// --check it exits 1 naming each file that differs from what would be written.
// A suite that does not lint clean refuses the whole run (exit 2), writing
// nothing.
func Generate(options cli.Options) Report {
	var plans []*generate.Plan
	var findings []string
	for _, path := range options.Configs {
		config, err := generate.LoadConfig(path)
		if err != nil {
			return refused(err.Error())
		}
		plan, found, err := generate.Build(config)
		if err != nil {
			return refused(err.Error())
		}
		if plan == nil {
			for _, finding := range found {
				findings = append(findings, finding.Human())
			}
			continue
		}
		plans = append(plans, plan)
	}
	if len(findings) > 0 {
		findings = append(findings, "Nothing was generated: every suite has to lint clean first.")
		return Report{Errors: strings.Join(findings, "\n"), Code: cli.ExitRefused}
	}
	if options.Plan {
		if len(plans) != 1 {
			return refused("--plan prints one config's plan; give one --config.")
		}
		return Report{Out: plans[0].JSON(), Code: cli.ExitPassed}
	}
	// The plan is the same whatever the provider; the code is not.
	for _, plan := range plans {
		if named := plan.Config.Provider; named != "" && named != "go" && options.Provider == "" {
			return refused(fmt.Sprintf("%s names the %s provider; the Go runtime generates for go.", plan.Config.File, named))
		}
	}
	if options.Provider != "" && options.Provider != "go" {
		return refused(options.Provider + " is not a Go provider; the Go runtime generates for go.")
	}
	first := plans[0].Config
	folder := first.Directory()
	if first.OutputFolder != "" {
		folder = filepath.Join(folder, filepath.FromSlash(first.OutputFolder))
	}
	if options.Out != "" {
		folder = options.Out
	}
	folder, err := filepath.Abs(folder)
	if err != nil {
		return refused(err.Error())
	}
	packageName := first.Package
	if packageName == "" {
		packageName = "bddsuite"
	}
	files, err := generate.Render(plans, folder, packageName)
	if err != nil {
		return refused(err.Error())
	}
	outcome, err := generate.Write(folder, files, options.Check)
	if err != nil {
		return refused(err.Error())
	}
	if options.Check {
		if len(outcome.Stale) == 0 {
			return Report{Out: fmt.Sprintf("%d generated file(s) are up to date.", len(files)), Code: cli.ExitPassed}
		}
		lines := []string{}
		for _, name := range outcome.Stale {
			lines = append(lines, "stale: "+name)
		}
		lines = append(lines, "Run suiterun generate (go generate) to write them again.")
		return Report{Out: strings.Join(lines, "\n"), Code: cli.ExitFailed}
	}
	lines := []string{}
	for _, name := range outcome.Written {
		lines = append(lines, "wrote "+name)
	}
	for _, name := range outcome.Removed {
		lines = append(lines, "removed "+name)
	}
	suites, tests := 0, 0
	for _, plan := range plans {
		suites += len(plan.Suites)
		for _, one := range plan.Suites {
			tests += len(one.Cases)
		}
	}
	lines = append(lines, fmt.Sprintf("go: %d suite(s), %d test(s) in %s", suites, tests, folder))
	return Report{Out: strings.Join(lines, "\n"), Code: cli.ExitPassed}
}
