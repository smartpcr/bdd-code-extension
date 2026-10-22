// One test that says the corpus is fully run by this binding.
//
// The four family tests beside this one each enumerate the manifest for their
// own kind. What this one adds is the guarantee that nothing in the manifest
// falls outside all four: an entry of a kind no test handles, a table or a
// report nobody reads, or a suite calling an action this binding does not
// implement would otherwise be skipped in silence, and a corpus that is quietly
// skipped looks like coverage and is not.

package conformance

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/where"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/exec"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

func TestEveryEntryIsOfAKindThisBindingRuns(t *testing.T) {
	corpus, err := Find()
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := corpus.Manifest()
	if err != nil {
		t.Fatal(err)
	}
	entries := Entries(manifest, "")
	if len(entries) < 50 {
		t.Fatalf("only %d entries", len(entries))
	}
	unknown := []string{}
	for _, entry := range entries {
		kind := walk.Text(entry, "kind")
		if kind != "validate" && kind != "execute" {
			if kind == "" {
				kind = "(none)"
			}
			unknown = append(unknown, kind)
		}
	}
	if len(unknown) > 0 {
		t.Errorf("the manifest holds entries of kinds no test here runs: %s", strings.Join(unknown, ", "))
	}
	// The corpus as it stands here: 42 validate entries (os-context's
	// lifecycle and E214 entries moved to os-context, DEC-S02) and 21 execute
	// entries, of which stage K0's one validate and six execute entries are
	// pending in every runtime. A pending entry is neither run nor counted as
	// passed (conformance/README.md); the family tests skip it and name it.
	if got := len(Entries(manifest, "validate")); got != 42 {
		t.Errorf("%d validate entries, not 42", got)
	}
	if got := len(Entries(manifest, "execute")); got != 21 {
		t.Errorf("%d execute entries, not 21", got)
	}
	pending := []string{}
	for _, entry := range entries {
		if PendingIn(entry, "go") {
			pending = append(pending, walk.Text(entry, "kind")+" "+walk.Text(entry, "suite"))
		}
	}
	t.Logf("%d of %d entries pending for go: %s", len(pending), len(entries), strings.Join(pending, ", "))
	if root := walk.Text(manifest, "schemaRoot"); root != "schema" {
		t.Errorf("the manifest's schemaRoot is %q, not schema", root)
	}
}

func TestEveryFileTheManifestNamesIsThere(t *testing.T) {
	corpus, err := Find()
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := corpus.Manifest()
	if err != nil {
		t.Fatal(err)
	}
	named := []string{}
	folders := []string{}
	for _, entry := range Entries(manifest, "") {
		for _, key := range []string{"suite", "expectation", "catalogOverlay", "progress"} {
			if name := walk.Text(entry, key); name != "" {
				named = append(named, name)
			}
		}
		// An entry's own schemaRoot names a folder, not a file.
		if name := walk.Text(entry, "schemaRoot"); name != "" {
			folders = append(folders, name)
		}
	}
	support, _ := walk.List(manifest, "support")
	for _, raw := range support {
		if name, ok := raw.(string); ok {
			named = append(named, name)
		}
	}
	tables, _ := walk.List(manifest, "tables")
	for _, raw := range tables {
		table, ok := walk.AsMap(raw)
		if !ok {
			continue
		}
		for _, key := range []string{"context", "cases"} {
			if name := walk.Text(table, key); name != "" {
				named = append(named, name)
			}
		}
	}
	if reports, ok := walk.AsMap(manifest.Value("reports")); ok {
		if name := walk.Text(reports, "definition"); name != "" {
			named = append(named, name)
		}
		entries, _ := walk.List(reports, "entries")
		for _, raw := range entries {
			entry, ok := walk.AsMap(raw)
			if !ok {
				continue
			}
			for _, key := range []string{"suite", "expected"} {
				if name := walk.Text(entry, key); name != "" {
					named = append(named, name)
				}
			}
		}
	}

	missing := []string{}
	for _, name := range named {
		if info, err := os.Stat(corpus.Path(name)); err != nil || info.IsDir() {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		t.Errorf("the manifest names files that are not there: %s", strings.Join(missing, ", "))
	}
	absent := []string{}
	for _, name := range folders {
		if info, err := os.Stat(corpus.Path(name)); err != nil || !info.IsDir() {
			absent = append(absent, name)
		}
	}
	if len(absent) > 0 {
		t.Errorf("the manifest names schema folders that are not there: %s", strings.Join(absent, ", "))
	}
}

func TestEveryActionTheExecuteCorpusCallsIsOneThisBindingImplements(t *testing.T) {
	corpus, err := Find()
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := corpus.Manifest()
	if err != nil {
		t.Fatal(err)
	}
	implemented := map[string]bool{}
	// The core, wait and the corpus extension's fixture.append.
	composite, err := extension.Compose(where.CorpusExtension)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range exec.AllNames(composite) {
		implemented[name] = true
	}
	called := map[string]bool{}
	for _, entry := range Entries(manifest, "execute") {
		if PendingIn(entry, "go") {
			continue
		}
		held, err := corpus.YAML(walk.Text(entry, "suite"))
		if err != nil {
			t.Fatalf("%s: %v", walk.Text(entry, "suite"), err)
		}
		collectActions(held, called)
	}
	if len(called) == 0 {
		t.Fatal("the execute corpus calls no actions at all")
	}
	missing := []string{}
	for _, name := range sortedSet(called) {
		if !implemented[name] {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		t.Errorf("the execute corpus calls actions this binding does not implement: %s",
			strings.Join(missing, ", "))
	}
}

func collectActions(held any, found map[string]bool) {
	switch value := held.(type) {
	case *model.Map:
		if name, ok := value.Value("action").(string); ok && name != "" {
			found[name] = true
		}
		for _, key := range value.Keys() {
			collectActions(value.Value(key), found)
		}
	case []any:
		for _, item := range value {
			collectActions(item, found)
		}
	}
}

// The core catalog agrees with what this runtime registers: every core action
// the catalog lists for go is registered, and nothing else is, so a core
// action cannot be implemented without being declared or declared without
// being implemented. A workspace's own actions come from extensions.
func TestTheCoreCatalogsGoSetIsExactlyTheRegisteredNames(t *testing.T) {
	text, err := os.ReadFile(where.CoreCatalog())
	if err != nil {
		t.Fatal(err)
	}
	document, err := model.Load(string(text))
	if err != nil {
		t.Fatal(err)
	}
	catalog, _ := walk.AsMap(document.Value)
	declared := []string{}
	entries, _ := walk.List(catalog, "actions")
	for _, raw := range entries {
		entry, ok := walk.AsMap(raw)
		if !ok {
			continue
		}
		bindings, _ := walk.List(entry, "bindings")
		for _, binding := range bindings {
			if binding == "go" {
				declared = append(declared, walk.Text(entry, "name"))
				break
			}
		}
	}
	sort.Strings(declared)
	registered := exec.AllNames(nil)
	t.Logf("%d registered: %s", len(registered), strings.Join(registered, ", "))
	if strings.Join(registered, ",") != strings.Join(declared, ",") {
		t.Errorf("registered %v; the core catalog declares for go %v", registered, declared)
	}
	if len(registered) != 7 {
		t.Errorf("%d core actions registered, not 7 (core.* and wait)", len(registered))
	}
}

func sortedSet(held map[string]bool) []string {
	names := make([]string, 0, len(held))
	for name := range held {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// The manifest the other way: every file under validate/ and execute/ is an
// entry or named as support, so a file cannot sit in the corpus unrun.
func TestEveryFileUnderValidateAndExecuteIsNamed(t *testing.T) {
	corpus, err := Find()
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := corpus.Manifest()
	if err != nil {
		t.Fatal(err)
	}
	known := map[string]bool{}
	for _, entry := range Entries(manifest, "") {
		// progress names the expected --progress output (execute/progress.expected.txt).
		for _, key := range []string{"suite", "expectation", "catalogOverlay", "progress"} {
			if name := walk.Text(entry, key); name != "" {
				known[name] = true
			}
		}
	}
	support, _ := walk.List(manifest, "support")
	for _, raw := range support {
		if name, ok := raw.(string); ok {
			known[name] = true
		}
	}
	stray := []string{}
	for _, directory := range []string{"validate", "execute"} {
		err := filepath.WalkDir(corpus.Path(directory), func(path string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return err
			}
			relative, err := filepath.Rel(corpus.Directory, path)
			if err != nil {
				return err
			}
			if name := filepath.ToSlash(relative); !known[name] {
				stray = append(stray, name)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(stray) > 0 {
		t.Errorf("files no entry names: %s", strings.Join(stray, ", "))
	}
}

// TestTheModuleCarriesTheRepositorysLicense: a module zip holds only the
// module's folder, and pkg.go.dev shows a module's documentation only when its
// zip holds a license, so runtimes/go/LICENSE is a copy of the repository's
// (docs/packages, DEC-P11).
func TestTheModuleCarriesTheRepositorysLicense(t *testing.T) {
	corpus, err := Find()
	if err != nil {
		t.Fatal(err)
	}
	root, err := os.ReadFile(filepath.Join(corpus.Root, "LICENSE"))
	if err != nil {
		t.Fatal(err)
	}
	module, err := os.ReadFile(filepath.Join(corpus.Root, "runtimes", "go", "LICENSE"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.ReplaceAll(string(module), "\r\n", "\n") != strings.ReplaceAll(string(root), "\r\n", "\n") {
		t.Error("runtimes/go/LICENSE differs from the repository's LICENSE: copy it again")
	}
}
