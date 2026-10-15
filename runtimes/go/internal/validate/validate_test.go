package validate

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/where"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/diag"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/schema"
)

// The validate corpus in conformance/ is what says this linter agrees with
// the other runtimes. What is here is the extension hooks: context keys, lint
// rules, the imports a rule sees, the environment prefix, and that the
// product rules the core used to carry are gone from it.

func corpusSchema(t *testing.T) *schema.Schema {
	t.Helper()
	loaded, err := schema.Load(where.CorpusSchema())
	if err != nil {
		t.Fatal(err)
	}
	return loaded
}

// lintText writes files into a fresh directory and lints the first one.
func lintText(t *testing.T, options *Options, files map[string]string) []string {
	t.Helper()
	directory := t.TempDir()
	for name, text := range files {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	found, err := File(filepath.Join(directory, "suite.yml"), "suite.yml", corpusSchema(t), options)
	if err != nil {
		t.Fatal(err)
	}
	return codes(found)
}

func codes(found []diag.Diagnostic) []string {
	out := []string{}
	for _, one := range found {
		out = append(out, one.Code)
	}
	return out
}

func compose(t *testing.T, extensions ...extension.Extension) *extension.Composite {
	t.Helper()
	composite, err := extension.Compose(extensions...)
	if err != nil {
		t.Fatal(err)
	}
	return composite
}

const readsRegion = `suite: s
tests:
  - name: c
    steps:
      - action: core.set
        value: ${region}
`

func TestAContextKeyIsKnownOnlyWithTheExtensionThatDeclaresIt(t *testing.T) {
	without := lintText(t, &Options{}, map[string]string{"suite.yml": readsRegion})
	if !reflect.DeepEqual(without, []string{"E301"}) {
		t.Errorf("without the extension: %v", without)
	}
	with := lintText(t, &Options{Extensions: compose(t, extension.Extension{Name: "r", ContextKeys: []string{"region"}})},
		map[string]string{"suite.yml": readsRegion})
	if len(with) != 0 {
		t.Errorf("with the extension: %v", with)
	}
	// The core's own context keys need no extension.
	core := lintText(t, &Options{}, map[string]string{"suite.yml": strings.Replace(readsRegion, "${region}", "${timeoutSec}", 1)})
	if len(core) != 0 {
		t.Errorf("timeoutSec: %v", core)
	}
}

func TestAnExtensionsRuleSeesTheFileAndItsImportsAndItsFindingsAreSortedIn(t *testing.T) {
	var seen extension.RuleInput
	rule := extension.Extension{Name: "rule", Rules: extension.Rules{Lint: func(input extension.RuleInput) []diag.Diagnostic {
		seen = input
		return []diag.Diagnostic{diag.NewError("E205", input.File, input.Document.At("/suite").Value, "from the rule")}
	}}}
	found := lintText(t, &Options{Extensions: compose(t, rule)}, map[string]string{
		"suite.yml":     "suite: s\nimports:\n  - lib.yml\n  - missing.yml\ntests:\n  - name: c\n    steps:\n      - action: core.noop\n",
		"lib.yml":       "defaults:\n  k: v\n",
		"unrelated.yml": "x: 1\n",
	})
	// The rule's E205 (line 1) sorts before the core's E301 for the missing import (line 4).
	if !reflect.DeepEqual(found, []string{"E205", "E301"}) {
		t.Errorf("the findings are %v", found)
	}
	if seen.File != "suite.yml" || seen.Suite == nil || seen.Document == nil {
		t.Errorf("the rule saw %+v", seen)
	}
	if len(seen.Imports) != 1 || seen.Imports[0].Import != "lib.yml" || seen.Imports[0].Pointer != "/imports/0" ||
		!strings.HasSuffix(seen.Imports[0].File, "lib.yml") || !filepath.IsAbs(seen.Imports[0].File) {
		t.Errorf("the rule saw the imports %+v", seen.Imports)
	}
}

func TestTheParamPrefixIsTheComposites(t *testing.T) {
	suite := "suite: s\nparams:\n  - { name: site }\ntests:\n  - name: c\n    steps:\n      - action: core.set\n        value: ${param.site}\n"
	t.Setenv("BDD_SUITE_PARAM_SITE", "")
	t.Setenv("ACME_PARAM_SITE", "")
	os.Unsetenv("BDD_SUITE_PARAM_SITE")
	os.Unsetenv("ACME_PARAM_SITE")
	if got := lintText(t, &Options{}, map[string]string{"suite.yml": suite}); !reflect.DeepEqual(got, []string{"E210"}) {
		t.Errorf("with no value anywhere: %v", got)
	}
	t.Setenv("BDD_SUITE_PARAM_SITE", "x")
	if got := lintText(t, &Options{}, map[string]string{"suite.yml": suite}); len(got) != 0 {
		t.Errorf("with BDD_SUITE_PARAM_SITE: %v", got)
	}
	acme := compose(t, extension.Extension{Name: "acme", EnvPrefix: "ACME_"})
	if got := lintText(t, &Options{Extensions: acme}, map[string]string{"suite.yml": suite}); !reflect.DeepEqual(got, []string{"E210"}) {
		t.Errorf("an extension's prefix still read BDD_SUITE_: %v", got)
	}
	t.Setenv("ACME_PARAM_SITE", "x")
	if got := lintText(t, &Options{Extensions: acme}, map[string]string{"suite.yml": suite}); len(got) != 0 {
		t.Errorf("with ACME_PARAM_SITE: %v", got)
	}
}

// The product rules the core used to carry belong to an extension now
// (DEC-S05): a suite tagged lifecycle has no 900-second ceiling and needs no
// per-case limit, and a suite importing a shared-checks library is not E214.
func TestTheCoreCarriesNoProductRules(t *testing.T) {
	tagged := "suite: s\ntags: [lifecycle]\ndefaults:\n  timeoutSec: 1200\ntests:\n  - name: c\n    steps:\n      - action: core.noop\n"
	if got := lintText(t, &Options{}, map[string]string{"suite.yml": tagged}); len(got) != 0 {
		t.Errorf("a tagged suite: %v", got)
	}
	shared := "suite: s\nimports:\n  - shared-checks.yml\ntests:\n  - name: c\n    steps:\n      - action: core.noop\n"
	library := "metaSteps:\n  - name: check-r1-preview\n    steps:\n      - action: core.noop\n"
	if got := lintText(t, &Options{}, map[string]string{"suite.yml": shared, "shared-checks.yml": library}); len(got) != 0 {
		t.Errorf("a suite importing shared checks: %v", got)
	}
	// The core's own ceiling still holds for every suite.
	over := strings.Replace(tagged, "1200", "20000", 1)
	if got := lintText(t, &Options{}, map[string]string{"suite.yml": over}); !reflect.DeepEqual(got, []string{"E205"}) {
		t.Errorf("a limit over the core's ceiling: %v", got)
	}
}
