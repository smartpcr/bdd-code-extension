package generate

import (
	"io/fs"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
)

// Select is the files the includes match and the excludes do not, as paths
// relative to folder with forward slashes, in ordinal order
// (spec/test-plan.md, Building the plan, step 1): ** any number of folders, *
// any text inside one name, ? one character, and .. allowed before the first
// wildcard.
func Select(folder string, includes, excludes []string) ([]string, error) {
	root, err := filepath.Abs(folder)
	if err != nil {
		return nil, err
	}
	var rejected []*regexp.Regexp
	for _, pattern := range excludes {
		rejected = append(rejected, matcher(root, pattern))
	}
	found := map[string]bool{}
	for _, pattern := range includes {
		start, _ := split(root, pattern)
		accept := matcher(root, pattern)
		_ = filepath.WalkDir(start, func(path string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return nil
			}
			full := normal(path)
			if !accept.MatchString(full) {
				return nil
			}
			for _, reject := range rejected {
				if reject.MatchString(full) {
					return nil
				}
			}
			relative, err := filepath.Rel(root, path)
			if err == nil {
				found[filepath.ToSlash(relative)] = true
			}
			return nil
		})
	}
	out := make([]string, 0, len(found))
	for one := range found {
		out = append(out, one)
	}
	sort.Strings(out)
	return out, nil
}

func normal(path string) string {
	full, err := filepath.Abs(path)
	if err != nil {
		full = path
	}
	return filepath.ToSlash(full)
}

// split is the folder a pattern starts in (its segments before the first
// wildcard) and the rest.
func split(root, pattern string) (string, string) {
	segments := strings.Split(pattern, "/")
	fixed := 0
	for fixed < len(segments)-1 && !strings.ContainsAny(segments[fixed], "*?") {
		fixed++
	}
	start := filepath.Join(append([]string{root}, segments[:fixed]...)...)
	return filepath.Clean(start), strings.Join(segments[fixed:], "/")
}

func matcher(root, pattern string) *regexp.Regexp {
	start, rest := split(root, pattern)
	built := strings.Builder{}
	if runtime.GOOS == "windows" {
		built.WriteString("(?i)")
	}
	built.WriteString("^")
	built.WriteString(regexp.QuoteMeta(strings.TrimSuffix(normal(start), "/")))
	built.WriteString("/")
	for index := 0; index < len(rest); index++ {
		one := rest[index]
		switch {
		case one == '*' && index+1 < len(rest) && rest[index+1] == '*':
			if index+2 < len(rest) && rest[index+2] == '/' {
				built.WriteString("(?:.*/)?")
				index += 2
			} else {
				built.WriteString(".*")
				index++
			}
		case one == '*':
			built.WriteString("[^/]*")
		case one == '?':
			built.WriteString("[^/]")
		default:
			built.WriteString(regexp.QuoteMeta(string(one)))
		}
	}
	built.WriteString("$")
	return regexp.MustCompile(built.String())
}
