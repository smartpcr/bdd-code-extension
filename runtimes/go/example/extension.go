// Package example is an example extension (E3): what a workspace writes to add
// to the runtime without editing it. It uses only the runtime's public
// packages (suite/...), never one under internal/.
//
// It adds one of each part of the extension API:
//
//	action       example.echo    returns its text, prefixed with the region
//	context key  region          ${region} in any expression
//	option       --region        where the region comes from
//	rule         a ceiling       a suite tagged slow keeps every case within 10 seconds
//
// Its own suiterun is cmd/suiterun beside this file.
package example

import (
	"fmt"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/actions"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/diag"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

// SlowCeilingSec is the most a case of a suite tagged slow may take.
const SlowCeilingSec = 10

// state is what one run of the extension hands its action.
type state struct {
	region string
}

func isSlow(suite *model.Map) bool {
	tags, _ := walk.List(suite, "tags")
	for _, tag := range tags {
		if tag == "slow" {
			return true
		}
	}
	return false
}

// echo returns {echoed: "<region>:<text>"}.
func echo(request *actions.Request) (any, error) {
	text, ok := request.Step.Value("text").(string)
	if !ok {
		return nil, actions.Failed("example.echo needs a text.")
	}
	region := ""
	if held, ok := request.State.(state); ok {
		region = held.region
	}
	out := model.NewMap()
	out.Set("echoed", region+":"+text)
	return out, nil
}

// lint is the ceiling at lint time: a case of a slow suite that declares more
// than the ceiling is E205, at the value, like the core's limits.
func lint(input extension.RuleInput) []diag.Diagnostic {
	found := []diag.Diagnostic{}
	if !isSlow(input.Suite) {
		return found
	}
	tests, _ := walk.List(input.Suite, "tests")
	for index, raw := range tests {
		held, ok := walk.AsMap(raw)
		if !ok {
			continue
		}
		declared, ok := held.Value("timeoutSec").(int64)
		if !ok || declared <= SlowCeilingSec {
			continue
		}
		found = append(found, diag.NewError("E205", input.File,
			input.Document.At(fmt.Sprintf("/tests/%d/timeoutSec", index)).Value,
			fmt.Sprintf("Case %s declares %d seconds; a suite tagged slow keeps each case within %d.",
				walk.Text(held, "name"), declared, SlowCeilingSec)))
	}
	return found
}

// caseLimit is the ceiling at run time: whatever a slow suite's case
// declares, it runs within the ceiling.
func caseLimit(suite *model.Map, declaredSec int64) int64 {
	if isSlow(suite) && declaredSec > SlowCeilingSec {
		return SlowCeilingSec
	}
	return declaredSec
}

// Echo is the example extension.
var Echo = extension.Extension{
	Name:        "example",
	Actions:     []actions.Registration{{Name: "example.echo", Handler: echo}},
	ContextKeys: []string{"region"},
	Options:     []extension.Option{{Flag: "--region", Description: "The region ${region} reads, and example.echo prefixes."}},
	Start: func(options map[string]string) extension.RunState {
		region := options["--region"]
		return extension.RunState{Context: map[string]any{"region": region}, State: state{region: region}}
	},
	Rules: extension.Rules{Lint: lint, CaseLimitSec: caseLimit},
}
