package schema

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/where"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
)

// committed is the corpus's schema: its catalog imports the core catalog.
func committed(t *testing.T) *Schema {
	t.Helper()
	loaded, err := Load(where.CorpusSchema())
	if err != nil {
		t.Fatal(err)
	}
	return loaded
}

func TestTheCatalogDeclaresTheActionsTheSuitesCall(t *testing.T) {
	loaded := committed(t)
	// core.noop and wait come from the imported core catalog; fixture.state
	// is the corpus catalog's own.
	if !loaded.Has("core.noop") || !loaded.Has("wait") || !loaded.Has("fixture.state") {
		t.Error("the catalog is missing an action every suite uses")
	}
	if len(loaded.ActionNames) < 12 {
		t.Errorf("only %d actions", len(loaded.ActionNames))
	}
	for index := 1; index < len(loaded.ActionNames); index++ {
		if loaded.ActionNames[index-1] > loaded.ActionNames[index] {
			t.Fatal("the names do not come out in one order")
		}
	}
}

func TestAnActionCarriesWhatTheCatalogSaysAboutIt(t *testing.T) {
	loaded := committed(t)
	invoke := loaded.Actions["invoke"]
	if !reflect.DeepEqual(invoke.Bindings, []string{"powershell"}) {
		t.Errorf("invoke is implemented by %v", invoke.Bindings)
	}
	if invoke.Interruptible || invoke.Deprecated {
		t.Error("invoke's flags")
	}
	if !contains(invoke.Params, "script") {
		t.Errorf("invoke takes %v", invoke.Params)
	}
	noop := loaded.Actions["core.noop"]
	if !contains(noop.Bindings, "go") || !noop.Interruptible {
		t.Errorf("core.noop is %v", noop)
	}
}

func TestTheStepUnionIsSwappedForTheEnvelope(t *testing.T) {
	loaded := committed(t)
	if !reflect.DeepEqual(loaded.Defs["step"], loaded.Defs["stepEnvelope"]) {
		t.Error("the step definition is not the envelope")
	}
	defs, _ := loaded.Document["$defs"].(map[string]any)
	if !reflect.DeepEqual(defs["step"], loaded.Defs["stepEnvelope"]) {
		t.Error("the document still carries the union")
	}
}

func TestTheOperatorAndCommonKeyListsComeFromTheSchema(t *testing.T) {
	loaded := committed(t)
	if !contains(loaded.AssertOperators, "equals") || !contains(loaded.AssertOperators, "isNotNull") {
		t.Errorf("the operators are %v", loaded.AssertOperators)
	}
	if contains(loaded.AssertOperators, "var") {
		t.Error("var is a subject, not an operator")
	}
	if !contains(loaded.StepCommonKeys, "captureAs") || !contains(loaded.StepCommonKeys, "timeoutSec") {
		t.Errorf("the common keys are %v", loaded.StepCommonKeys)
	}
}

func TestAMissingSchemaSaysWhichFileAndWhatToRun(t *testing.T) {
	_, err := Load(filepath.Join(t.TempDir(), "nowhere-at-all"))
	if err == nil {
		t.Fatal("a missing schema loaded")
	}
	if !containsText(err.Error(), "Build-Schema.ps1") {
		t.Errorf("the refusal says %q", err)
	}
}

func TestAnOverlayPatchesTheCatalogAndTheBranchItGenerated(t *testing.T) {
	base := committed(t)
	overlay, err := model.Load("actions:\n  - name: core.noop\n    deprecated: true\n    params:\n      - name: extra\n        type: string\n")
	if err != nil {
		t.Fatal(err)
	}
	patched, err := WithOverlay(base, overlay.Value)
	if err != nil {
		t.Fatal(err)
	}
	if !patched.Actions["core.noop"].Deprecated {
		t.Error("the overlay did not deprecate the action")
	}
	if !contains(patched.Actions["core.noop"].Params, "extra") {
		t.Error("the overlay did not add the parameter")
	}
	branch, _ := patched.Defs["step.core.noop"].(map[string]any)
	properties, _ := branch["properties"].(map[string]any)
	if _, found := properties["extra"]; !found {
		t.Error("the generated branch did not gain the parameter")
	}
	if base.Actions["core.noop"].Deprecated {
		t.Error("the overlay changed the schema it was built from")
	}
	if _, found := base.Defs["step.core.noop"].(map[string]any)["properties"].(map[string]any)["extra"]; found {
		t.Error("the overlay changed the branch of the schema it was built from")
	}
}

func TestAnOverlayThatPatchesNothingIsRefused(t *testing.T) {
	base := committed(t)
	overlay, err := model.Load("actions:\n  - name: nothing.at.all\n    deprecated: true\n")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := WithOverlay(base, overlay.Value); err == nil {
		t.Error("an overlay naming an unknown action was accepted")
	}
}

func containsText(haystack, needle string) bool {
	return len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

func indexOf(haystack, needle string) int {
	for at := 0; at+len(needle) <= len(haystack); at++ {
		if haystack[at:at+len(needle)] == needle {
			return at
		}
	}
	return -1
}

// writeCatalogs writes catalogs into a fresh directory, each name to its text,
// with the corpus's suite.schema.json beside the root catalog so Load can run.
func writeCatalogs(t *testing.T, files map[string]string) string {
	t.Helper()
	directory := t.TempDir()
	for name, text := range files {
		path := filepath.Join(directory, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	generated, err := os.ReadFile(filepath.Join(where.CorpusSchema(), "suite.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "suite.schema.json"), generated, 0o600); err != nil {
		t.Fatal(err)
	}
	return directory
}

func TestACatalogImportsDepthFirstRelativeToTheImportingFile(t *testing.T) {
	directory := writeCatalogs(t, map[string]string{
		"actions.catalog.yaml": "imports:\n  - lib/a.yaml\n  - lib/b.yaml\nactions:\n  - { name: own.one, bindings: [go] }\n",
		"lib/a.yaml":           "imports:\n  - deeper/c.yaml\nactions:\n  - { name: a.one, bindings: [go] }\n",
		"lib/deeper/c.yaml":    "actions:\n  - { name: c.one, bindings: [go], interruptible: false }\n",
		"lib/b.yaml":           "actions:\n  - { name: b.one, bindings: [rust] }\n",
	})
	loaded, err := Load(directory)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"a.one", "b.one", "c.one", "own.one"}
	if !reflect.DeepEqual(loaded.ActionNames, want) {
		t.Errorf("the actions are %v", loaded.ActionNames)
	}
	if loaded.Actions["c.one"].Interruptible {
		t.Error("an imported action lost what its catalog says")
	}
	entries, err := catalogEntries(filepath.Join(directory, "actions.catalog.yaml"), nil)
	if err != nil {
		t.Fatal(err)
	}
	order := []string{}
	for _, entry := range entries {
		order = append(order, entry.entry.Value("name").(string))
	}
	if !reflect.DeepEqual(order, []string{"c.one", "a.one", "b.one", "own.one"}) {
		t.Errorf("the reading order is %v", order)
	}
}

func TestTheCorpusCatalogImportsTheCore(t *testing.T) {
	loaded := committed(t)
	for _, name := range []string{"core.noop", "core.set", "core.fail", "core.skip", "core.sleep", "core.record", "wait"} {
		if !loaded.Has(name) || !contains(loaded.Actions[name].Bindings, "go") {
			t.Errorf("%s does not come from the imported core for go", name)
		}
	}
}

func TestANameDeclaredTwiceIsRefusedNamingBothFiles(t *testing.T) {
	directory := writeCatalogs(t, map[string]string{
		"actions.catalog.yaml": "imports:\n  - other.yaml\nactions:\n  - { name: same.name, bindings: [go] }\n",
		"other.yaml":           "actions:\n  - { name: same.name, bindings: [go] }\n",
	})
	_, err := Load(directory)
	if err == nil {
		t.Fatal("a name declared twice was accepted")
	}
	for _, part := range []string{"same.name is declared twice", "other.yaml", "actions.catalog.yaml"} {
		if !containsText(err.Error(), part) {
			t.Errorf("the refusal %q does not say %q", err, part)
		}
	}
}

func TestAnImportCycleIsRefused(t *testing.T) {
	directory := writeCatalogs(t, map[string]string{
		"actions.catalog.yaml": "imports:\n  - a.yaml\n",
		"a.yaml":               "imports:\n  - b.yaml\n",
		"b.yaml":               "imports:\n  - a.yaml\n",
	})
	_, err := Load(directory)
	if err == nil || !containsText(err.Error(), "Catalog import cycle") {
		t.Errorf("a cycle said %v", err)
	}
}

func TestAMissingImportIsRefusedNamingIt(t *testing.T) {
	directory := writeCatalogs(t, map[string]string{
		"actions.catalog.yaml": "imports:\n  - nowhere.yaml\n",
	})
	_, err := Load(directory)
	if err == nil || !containsText(err.Error(), "imports nowhere.yaml, which does not exist") {
		t.Errorf("a missing import said %v", err)
	}
}
