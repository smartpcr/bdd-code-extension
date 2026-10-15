// Package paths says where a workspace's schema is, and which files a glob
// names.
//
// The workspace root is found by walking up to test/e2e/schema (the layout a
// workspace uses by default), so the runtime works from any working directory
// and needs no environment variable set first; --schema-root names another
// place, and then no walk is needed (package run).
package paths

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// RepositoryRoot is the nearest ancestor of start holding test/e2e/schema.
func RepositoryRoot(start string) (string, bool) {
	here, err := filepath.Abs(start)
	if err != nil {
		return "", false
	}
	for {
		if info, err := os.Stat(filepath.Join(here, "test", "e2e", "schema")); err == nil && info.IsDir() {
			return here, true
		}
		parent := filepath.Dir(here)
		if parent == here {
			return "", false
		}
		here = parent
	}
}

// SchemaRoot is where suite.schema.json and actions.catalog.yaml are.
func SchemaRoot(root string) string { return filepath.Join(root, "test", "e2e", "schema") }

// MatchesGlob says whether a name matches a glob of the kind a --path takes:
// `*` for any run of characters inside one segment, `?` for one, and nothing
// else.
//
// Written out rather than taken from a library because the whole vocabulary is
// two characters, and because a library that treats `**` or `[a-z]` as
// meaningful would quietly accept patterns the other bindings do not.
func MatchesGlob(pattern, name string) bool {
	patternRunes := []rune(pattern)
	nameRunes := []rune(name)
	atPattern, atName := 0, 0
	star, starAtName := -1, 0
	for atName < len(nameRunes) {
		switch {
		case atPattern < len(patternRunes) && (patternRunes[atPattern] == '?' || patternRunes[atPattern] == nameRunes[atName]):
			atPattern++
			atName++
		case atPattern < len(patternRunes) && patternRunes[atPattern] == '*':
			star = atPattern
			starAtName = atName
			atPattern++
		case star >= 0:
			atPattern = star + 1
			starAtName++
			atName = starAtName
		default:
			return false
		}
	}
	for atPattern < len(patternRunes) && patternRunes[atPattern] == '*' {
		atPattern++
	}
	return atPattern == len(patternRunes)
}

// Resolve is every file a --path names, in one order on every machine.
func Resolve(pattern, workingDirectory string) ([]string, error) {
	raw := strings.ReplaceAll(pattern, "\\", "/")
	full := raw
	if !filepath.IsAbs(raw) {
		full = filepath.Join(workingDirectory, raw)
	}
	leaf := filepath.Base(full)
	if !strings.ContainsAny(leaf, "*?") {
		if info, err := os.Stat(full); err == nil && !info.IsDir() {
			return []string{full}, nil
		}
		return nil, fmt.Errorf("%s names no file", pattern)
	}
	directory := filepath.Dir(full)
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("%s cannot be read: %w", directory, err)
	}
	var found []string
	for _, entry := range entries {
		if entry.IsDir() || !MatchesGlob(leaf, entry.Name()) {
			continue
		}
		found = append(found, filepath.Join(directory, entry.Name()))
	}
	// Sorted, because a run's report lists its suites in the order they ran and
	// two machines must not order them differently.
	sort.Strings(found)
	if len(found) == 0 {
		return nil, fmt.Errorf("%s names no file", pattern)
	}
	return found, nil
}
