package generate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/where"
)

func corpusConfig(t *testing.T, relative string) *Config {
	t.Helper()
	config, err := LoadConfig(filepath.Join(where.Corpus(), filepath.FromSlash(relative)))
	if err != nil {
		t.Fatal(err)
	}
	return config
}

func corpusPlan(t *testing.T) *Plan {
	t.Helper()
	plan, findings, err := Build(corpusConfig(t, "generate/bddsuite.tests.yaml"))
	if err != nil || plan == nil {
		t.Fatalf("no plan: %v %v", err, findings)
	}
	return plan
}

func TestAnIdentifierIsTheNamesWordsCapitalised(t *testing.T) {
	for name, want := range map[string]string{
		"places an order": "PlacesAnOrder", "rejects a bad quantity [qty=-1]": "RejectsABadQuantityQty1",
		"3 retries": "N3Retries", "!!!": "Case", "café au lait": "CafAuLait", "MSTest_v4": "MSTestV4",
	} {
		if got := IdentifierOf(name, "Case"); got != want {
			t.Errorf("%q gives %s, not %s", name, got, want)
		}
	}
}

func TestACollisionTakesTheFirstFreeNumberIgnoringCase(t *testing.T) {
	ids := NewIdentifiers(ReservedInSuite...)
	for _, row := range [][2]string{
		{"setup", "Setup_2"}, {"places an order", "PlacesAnOrder"}, {"places an order!", "PlacesAnOrder_2"},
		{"PLACES AN ORDER", "PLACESANORDER_3"}, {"???", "Case"}, {"...", "Case_2"},
	} {
		if got := ids.Take(row[0], "Case"); got != row[1] {
			t.Errorf("%q gives %s, not %s", row[0], got, row[1])
		}
	}
}

func TestAnOfflinePatternCoversANameOrAPrefix(t *testing.T) {
	for _, row := range []struct {
		pattern, action string
		covers          bool
	}{{"core.*", "core.set", true}, {"core.*", "corelike.set", false}, {"wait", "wait", true}, {"wait", "waiting", false}, {"shop.orders.*", "shop.orders.place", true}} {
		if Covers(row.pattern, row.action) != row.covers {
			t.Errorf("%s over %s", row.pattern, row.action)
		}
	}
}

func TestTheGuardSeesMetaStepsFromLibrariesAndPolledSteps(t *testing.T) {
	for _, one := range corpusPlan(t).Suites {
		guarded := one.Name == "lab-work"
		if one.Guarded != guarded {
			t.Errorf("%s guarded %t", one.Name, one.Guarded)
		}
		if guarded && strings.Join(one.GuardedBy, ",") != "fixture.state,inventory.get" {
			t.Errorf("guarded by %v", one.GuardedBy)
		}
	}
}

func TestAConfigTheSchemaRefusesIsRefused(t *testing.T) {
	for yaml, says := range map[string]string{
		"schemaRoot: s":   "suites is required",
		"suites: [a.yml]": "schemaRoot is required",
		"suites: [a.yml]\nschemaRoot: s\nprovidr: go":                  "providr is not a config key",
		"suites: [a.yml]\nschemaRoot: s\nprovider: junit":              "provider is one of",
		"suites: ['a\\b.yml']\nschemaRoot: s":                          "backslash",
		"suites: [a.yml]\nschemaRoot: s\nofflineActions: ['core.*.x']": "prefix.*",
		"suites: [a.yml]\nschemaRoot: s\noutput: { dir: x }":           "output.dir is not an output key",
	} {
		path := filepath.Join(t.TempDir(), "config.yaml")
		if err := os.WriteFile(path, []byte(yaml), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadConfig(path); err == nil || !strings.Contains(err.Error(), says) {
			t.Errorf("%q: %v", yaml, err)
		}
	}
}

func TestAnExtensionIsAnImportPathAndAName(t *testing.T) {
	if path, symbol, err := extensionImport("example.com/shop/bindings/go/workspace.Shop"); err != nil || path != "example.com/shop/bindings/go/workspace" || symbol != "Shop" {
		t.Errorf("%s %s %v", path, symbol, err)
	}
	for _, bad := range []string{"Shop", "example.com/shop/", "example.com/shop."} {
		if _, _, err := extensionImport(bad); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}

// The Go code for the generate corpus equals the committed golden files
// (testdata/golden). With BDD_UPDATE_GOLDEN=1 the test writes them instead.
func TestTheGoCodeEqualsTheGoldenFiles(t *testing.T) {
	plan := corpusPlan(t)
	files, err := Render([]*Plan{plan}, plan.Config.Directory(), "bddsuite")
	if err != nil {
		t.Fatal(err)
	}
	golden := filepath.Join("testdata", "golden")
	update := os.Getenv("BDD_UPDATE_GOLDEN") == "1"
	if update {
		_ = os.MkdirAll(golden, 0o755)
	}
	names := []string{}
	for _, file := range files {
		path := filepath.Join(golden, file.Name+".golden")
		names = append(names, file.Name+".golden")
		if update {
			if err := os.WriteFile(path, []byte(file.Text), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		want, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s has no golden file; run with BDD_UPDATE_GOLDEN=1", file.Name)
		}
		if string(want) != file.Text {
			t.Errorf("%s differs from its golden file:\n%s", file.Name, file.Text)
		}
	}
	present, _ := filepath.Glob(filepath.Join(golden, "*.golden"))
	if len(present) != len(names) {
		t.Errorf("%d golden files, %d generated", len(present), len(names))
	}
}

func TestTheWriterRewritesOnlyWhatChangedAndRemovesOnlyItsOwnFiles(t *testing.T) {
	plan := corpusPlan(t)
	folder := t.TempDir()
	// Rendered as for the corpus's own folder (relative paths cannot cross a
	// drive), written to a scratch one.
	files, err := Render([]*Plan{plan}, plan.Config.Directory(), "bddsuite")
	if err != nil {
		t.Fatal(err)
	}
	first, err := Write(folder, files, false)
	if err != nil || len(first.Written) != len(files) {
		t.Fatalf("%v %v", first, err)
	}
	if again, _ := Write(folder, files, false); len(again.Written) != 0 {
		t.Errorf("unchanged files rewritten: %v", again.Written)
	}
	if check, _ := Write(folder, files, true); len(check.Stale) != 0 {
		t.Errorf("stale: %v", check.Stale)
	}
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.WriteFile(filepath.Join(folder, "Gone_bdd_test.go"), []byte(generatedPrefix+" (go) from gone.yml. DO NOT EDIT.\n"), 0o644))
	must(os.WriteFile(filepath.Join(folder, "Mine_bdd_test.go"), []byte("package bddsuite\n"), 0o644))
	edited := filepath.Join(folder, files[0].Name)
	must(os.WriteFile(edited, []byte(files[0].Text+"// edited by hand\n"), 0o644))
	check, _ := Write(folder, files, true)
	if strings.Join(check.Stale, ",") != files[0].Name+",Gone_bdd_test.go" {
		t.Errorf("stale: %v", check.Stale)
	}
	again, _ := Write(folder, files, false)
	if strings.Join(again.Written, ",") != files[0].Name || strings.Join(again.Removed, ",") != "Gone_bdd_test.go" {
		t.Errorf("written %v removed %v", again.Written, again.Removed)
	}
	if _, err := os.Stat(filepath.Join(folder, "Mine_bdd_test.go")); err != nil {
		t.Error("someone else's file was removed")
	}
}
