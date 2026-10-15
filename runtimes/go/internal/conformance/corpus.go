// Package conformance reads the corpus every binding is held to.
//
// Only the reading lives here. What each kind of entry means is in the test
// files beside it, one per family, so that a failure names the family it came
// from rather than one enormous test.
package conformance

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/where"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

// Corpus is where the shared fixtures are.
type Corpus struct {
	Root      string
	Directory string
}

// Find locates the corpus: conformance/ at this repository's root. Root is
// the repository root, which findings are reported relative to.
func Find() (*Corpus, error) {
	return &Corpus{Root: where.Repo(), Directory: where.Corpus()}, nil
}

// Schema is the corpus's schema root (run-manifest.yaml's schemaRoot).
func (corpus *Corpus) Schema() string { return where.CorpusSchema() }

// Path is one corpus file, by its manifest-relative name.
func (corpus *Corpus) Path(relative string) string {
	return filepath.Join(corpus.Directory, filepath.FromSlash(relative))
}

// Manifest is run-manifest.yaml, parsed.
func (corpus *Corpus) Manifest() (*model.Map, error) {
	return corpus.YAML("run-manifest.yaml")
}

// YAML is one corpus file, parsed as a mapping.
func (corpus *Corpus) YAML(relative string) (*model.Map, error) {
	text, err := os.ReadFile(corpus.Path(relative))
	if err != nil {
		return nil, err
	}
	document, err := model.Load(string(text))
	if err != nil {
		return nil, err
	}
	held, ok := document.Value.(*model.Map)
	if !ok {
		return nil, fmt.Errorf("%s does not hold a YAML mapping", relative)
	}
	return held, nil
}

// JSON is one corpus file, parsed as JSON, keeping the key order.
func (corpus *Corpus) JSON(relative string) (*model.Map, error) {
	text, err := os.ReadFile(corpus.Path(relative))
	if err != nil {
		return nil, err
	}
	var raw any
	if err := json.Unmarshal(text, &raw); err != nil {
		return nil, fmt.Errorf("%s is not JSON: %w", relative, err)
	}
	held, ok := ordered(raw).(*model.Map)
	if !ok {
		return nil, fmt.Errorf("%s does not hold a JSON object", relative)
	}
	return held, nil
}

// ordered turns what encoding/json produced into the same shapes the YAML
// reader produces, so one set of helpers reads both.
func ordered(value any) any {
	switch held := value.(type) {
	case map[string]any:
		out := model.NewMap()
		// A JSON object has no order to keep, so the keys go in sorted. What
		// matters is that a reader finds the same type here as it finds after a
		// YAML parse.
		for _, key := range sortedKeys(held) {
			out.Set(key, ordered(held[key]))
		}
		return out
	case []any:
		out := make([]any, 0, len(held))
		for _, item := range held {
			out = append(out, ordered(item))
		}
		return out
	case float64:
		// JSON has one number type; the rest of this binding tells a whole
		// number from a fraction, so it is told here too.
		if held == float64(int64(held)) {
			return int64(held)
		}
		return held
	default:
		return value
	}
}

func sortedKeys(held map[string]any) []string {
	names := make([]string, 0, len(held))
	for name := range held {
		names = append(names, name)
	}
	for one := 1; one < len(names); one++ {
		for other := one; other > 0 && names[other] < names[other-1]; other-- {
			names[other], names[other-1] = names[other-1], names[other]
		}
	}
	return names
}

// Entries is the manifest entries of one kind.
func Entries(manifest *model.Map, kind string) []*model.Map {
	out := []*model.Map{}
	items, _ := walk.List(manifest, "entries")
	for _, raw := range items {
		entry, ok := walk.AsMap(raw)
		if !ok {
			continue
		}
		if kind == "" || walk.Text(entry, "kind") == kind {
			out = append(out, entry)
		}
	}
	return out
}
