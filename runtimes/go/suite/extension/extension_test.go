package extension

import (
	"reflect"
	"strings"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/actions"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/diag"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
)

func handler(*actions.Request) (any, error) { return nil, nil }

func TestTheCoreAloneIsTheCoreActionsWaitAndTheCoreRoots(t *testing.T) {
	composite := CoreOnly()
	want := []string{"core.fail", "core.noop", "core.record", "core.set", "core.skip", "core.sleep", "wait"}
	if !reflect.DeepEqual(composite.Names(), want) {
		t.Errorf("the core registers %v", composite.Names())
	}
	if !reflect.DeepEqual(composite.Roots, []string{"capture", "param", "var", "row", "timeoutSec", "defaults"}) {
		t.Errorf("the core roots are %v", composite.Roots)
	}
	if len(composite.ContextKeys) != 0 || len(composite.Options) != 0 {
		t.Errorf("the core declares keys %v and options %v", composite.ContextKeys, composite.Options)
	}
	if composite.EnvPrefix != "BDD_SUITE_" || DefaultEnvPrefix != "BDD_SUITE_" {
		t.Errorf("the default prefix is %s", composite.EnvPrefix)
	}
	if composite.Actions["core.noop"].Owner != -1 || composite.Actions["wait"].OwnerName != "the core" {
		t.Error("a core action has an owner other than the core")
	}
	if found := composite.Lint(RuleInput{}); len(found) != 0 {
		t.Errorf("the core alone adds findings %v", found)
	}
	if composite.CaseLimitSec(model.NewMap(), 600) != 600 {
		t.Error("the core alone changes a case limit")
	}
}

func TestExtensionsComposeTheirActionsKeysOptionsAndPrefix(t *testing.T) {
	one := Extension{
		Name:        "one",
		Actions:     []actions.Registration{{Name: "one.act", Handler: handler}},
		ContextKeys: []string{"region"},
		Options:     []Option{{Flag: "--region", Description: "The region."}},
		EnvPrefix:   "ACME_",
	}
	two := Extension{
		Name:        "two",
		Actions:     []actions.Registration{{Name: "two.act", Handler: handler}},
		ContextKeys: []string{"zone"},
		Options:     []Option{{Flag: "--zone-name", Description: "The zone."}},
		EnvPrefix:   "ACME_",
	}
	composite, err := Compose(one, two)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(composite.Names(), []string{"core.fail", "core.noop", "core.record", "core.set", "core.skip", "core.sleep", "one.act", "two.act", "wait"}) {
		t.Errorf("the names are %v", composite.Names())
	}
	if composite.Actions["two.act"].Owner != 1 || composite.Actions["one.act"].OwnerName != "one" {
		t.Error("an action's owner is wrong")
	}
	if !reflect.DeepEqual(composite.ContextKeys, []string{"region", "zone"}) {
		t.Errorf("the context keys are %v", composite.ContextKeys)
	}
	if !reflect.DeepEqual(composite.Roots, append(append([]string(nil), CoreRoots...), "region", "zone")) {
		t.Errorf("the roots are %v", composite.Roots)
	}
	if len(composite.Options) != 2 || composite.Options[1].Flag != "--zone-name" {
		t.Errorf("the options are %v", composite.Options)
	}
	if composite.EnvPrefix != "ACME_" {
		t.Errorf("the prefix is %s", composite.EnvPrefix)
	}
}

func TestANameDefinedTwiceOrTakenFromTheCoreIsRefused(t *testing.T) {
	for _, row := range []struct {
		extensions []Extension
		message    string
	}{
		{[]Extension{
			{Name: "a", Actions: []actions.Registration{{Name: "x.act", Handler: handler}}},
			{Name: "b", Actions: []actions.Registration{{Name: "x.act", Handler: handler}}},
		}, "Action x.act is defined by both a and b."},
		{[]Extension{{Name: "a", Actions: []actions.Registration{{Name: "wait", Handler: handler}}}},
			"Action wait is defined by both the core and a."},
		{[]Extension{{Name: "a", Actions: []actions.Registration{{Name: "core.set", Handler: handler}}}},
			"Action core.set is defined by both the core and a."},
		{[]Extension{{Name: "a", ContextKeys: []string{"k"}}, {Name: "b", ContextKeys: []string{"k"}}},
			"Context key k is defined by both a and b."},
		{[]Extension{{Name: "a", ContextKeys: []string{"capture"}}},
			"Context key capture is defined by both the core and a."},
		{[]Extension{{Name: "a", ContextKeys: []string{"timeoutSec"}}},
			"Context key timeoutSec is defined by both the core and a."},
		{[]Extension{{Name: "a", Options: []Option{{Flag: "--Region"}}}},
			"a declares the option --Region; an option is --lower-case-words."},
		{[]Extension{{Name: "a", Options: []Option{{Flag: "region"}}}},
			"a declares the option region; an option is --lower-case-words."},
		{[]Extension{{Name: "a", Options: []Option{{Flag: "--x"}}}, {Name: "b", Options: []Option{{Flag: "--x"}}}},
			"Option --x is defined by both a and b."},
		{[]Extension{{Name: "a", Options: []Option{{Flag: "--path"}}}},
			"Option --path is defined by both the core and a."},
		{[]Extension{{Name: "a", EnvPrefix: "ONE_"}, {Name: "b", EnvPrefix: "TWO_"}},
			"a sets the environment prefix ONE_ and b sets TWO_."},
	} {
		_, err := Compose(row.extensions...)
		if err == nil {
			t.Errorf("[%s] was composed", row.message)
			continue
		}
		if err.Error() != row.message {
			t.Errorf("refused with %q, wanted %q", err, row.message)
		}
		if _, ok := err.(*Error); !ok {
			t.Errorf("[%s] is not an extension.Error", row.message)
		}
	}
}

func TestStartGivesEachExtensionItsOwnOptionsAndKeepsOnlyItsKeys(t *testing.T) {
	seen := map[string]map[string]string{}
	one := Extension{
		Name:        "one",
		ContextKeys: []string{"region"},
		Options:     []Option{{Flag: "--region"}},
		Start: func(options map[string]string) RunState {
			seen["one"] = options
			return RunState{
				Context: map[string]any{"region": options["--region"], "zone": "not one's key"},
				State:   "one's state",
				Redact:  func(text string) string { return strings.ReplaceAll(text, "alpha", "[a]") },
			}
		},
	}
	two := Extension{
		Name:    "two",
		Options: []Option{{Flag: "--zone"}},
		Start: func(options map[string]string) RunState {
			seen["two"] = options
			return RunState{Redact: func(text string) string { return strings.ReplaceAll(text, "[a]", "[redacted]") }}
		},
	}
	quiet := Extension{Name: "quiet"}
	composite, err := Compose(one, two, quiet)
	if err != nil {
		t.Fatal(err)
	}
	started := Start(composite, map[string]string{"--region": "eu", "--zone": "z1"})
	if !reflect.DeepEqual(seen["one"], map[string]string{"--region": "eu"}) || !reflect.DeepEqual(seen["two"], map[string]string{"--zone": "z1"}) {
		t.Errorf("the extensions saw %v", seen)
	}
	if !reflect.DeepEqual(started.Context, map[string]any{"region": "eu"}) {
		t.Errorf("the context is %v", started.Context)
	}
	if started.State(0) != "one's state" || started.State(1) != nil || started.State(2) != nil || started.State(-1) != nil || started.State(9) != nil {
		t.Errorf("the states are %v", started.States)
	}
	if got := started.Redact("alpha beta"); got != "[redacted] beta" {
		t.Errorf("the redaction chain gave %q", got)
	}
	var none *Started
	if none.Redact("alpha") != "alpha" || none.State(0) != nil {
		t.Error("a run with nothing started changed a text or had a state")
	}
}

func TestRulesAddFindingsAndTheSmallestLimitWins(t *testing.T) {
	finding := diag.NewError("E205", "f.yml", model.Position{Line: 1, Column: 1}, "a finding")
	composite, err := Compose(
		Extension{Name: "a", Rules: Rules{
			Lint:         func(input RuleInput) []diag.Diagnostic { return []diag.Diagnostic{finding} },
			CaseLimitSec: func(*model.Map, int64) int64 { return 100 },
		}},
		Extension{Name: "b", Rules: Rules{CaseLimitSec: func(_ *model.Map, declared int64) int64 { return declared / 2 }}},
		Extension{Name: "c", Rules: Rules{CaseLimitSec: func(*model.Map, int64) int64 { return 5000 }}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if found := composite.Lint(RuleInput{File: "f.yml"}); len(found) != 1 || found[0].Code != "E205" {
		t.Errorf("the findings are %v", found)
	}
	if limit := composite.CaseLimitSec(model.NewMap(), 600); limit != 100 {
		t.Errorf("the limit of 600 became %d", limit)
	}
	if limit := composite.CaseLimitSec(model.NewMap(), 60); limit != 30 {
		t.Errorf("the limit of 60 became %d", limit)
	}
}
