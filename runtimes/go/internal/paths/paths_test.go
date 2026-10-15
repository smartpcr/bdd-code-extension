package paths

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTheWorkspaceRootIsTheNearestOneHoldingTheSchema(t *testing.T) {
	workspace := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workspace, "test", "e2e", "schema"), 0o755); err != nil {
		t.Fatal(err)
	}
	deep := filepath.Join(workspace, "suites", "nested")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	root, found := RepositoryRoot(deep)
	if !found || !strings.EqualFold(root, workspace) {
		t.Errorf("from %s the root is %q (%v)", deep, root, found)
	}
	if SchemaRoot(root) != filepath.Join(workspace, "test", "e2e", "schema") {
		t.Errorf("the schema root is %s", SchemaRoot(root))
	}
	// A directory with no test/e2e/schema above it has no workspace root.
	if _, found := RepositoryRoot(t.TempDir()); found {
		t.Skip("the temporary directory sits inside a workspace on this machine")
	}
}

func TestAGlobMatchesOnlyWhatTheOtherBindingsMatch(t *testing.T) {
	for _, row := range []struct {
		pattern string
		name    string
		want    bool
	}{
		{"*.yml", "a.yml", true},
		{"*.yml", "a.yaml", false},
		{"stage-*.yml", "stage-0.yml", true},
		{"stage-*.yml", "host.yml", false},
		{"a?c.yml", "abc.yml", true},
		{"a?c.yml", "ac.yml", false},
		{"*", "anything", true},
		{"*.y*l", "a.yaml", true},
		{"exact.yml", "exact.yml", true},
		// No character class: a pattern that looks like one matches itself.
		{"[ab].yml", "a.yml", false},
		{"[ab].yml", "[ab].yml", true},
	} {
		if got := MatchesGlob(row.pattern, row.name); got != row.want {
			t.Errorf("%s against %s is %v", row.pattern, row.name, got)
		}
	}
}

func TestAPathThatNamesNothingSaysSo(t *testing.T) {
	working, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve("nosuchfile.yml", working); err == nil {
		t.Error("a missing file resolved")
	}
	if _, err := Resolve("nosuch*.yml", working); err == nil {
		t.Error("a glob matching nothing resolved")
	}
}

func TestAGlobComesBackSorted(t *testing.T) {
	directory := t.TempDir()
	for _, name := range []string{"c.yml", "a.yml", "b.yml", "skip.txt"} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte("suite: x\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	found, err := Resolve("*.yml", directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 3 {
		t.Fatalf("found %v", found)
	}
	for index, want := range []string{"a.yml", "b.yml", "c.yml"} {
		if filepath.Base(found[index]) != want {
			t.Errorf("entry %d is %s, wanted %s", index, filepath.Base(found[index]), want)
		}
	}
	one, err := Resolve("b.yml", directory)
	if err != nil || len(one) != 1 {
		t.Errorf("a plain name gave %v, %v", one, err)
	}
}
