// Package schema is the vocabulary every runtime shares: the generated schema
// and the action catalog, read from files at run time.
//
// Nothing here is compiled in. suite.schema.json and actions.catalog.yaml are
// the same two files every runtime reads and the spec's generator
// (Build-Schema.ps1) writes, so a runtime cannot hold an opinion about the
// format that the others do not share.
//
// A catalog may import other catalogs (DEC-S10): imports first, depth first in
// listed order, each relative to the file that names it; then the catalog's
// own actions. A name declared twice is refused naming both files, and an
// import cycle is refused.
package schema

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
)

// Action is one action as the catalog declares it.
type Action struct {
	Name          string
	Bindings      []string
	Interruptible bool
	Deprecated    bool
	Params        []string
	// Captures is the shape of what the action captures, or nothing when the
	// catalog leaves it open. Only a closed shape can be checked, which is what
	// keeps E302 honest about an API response nobody has declared.
	Captures any
	HasShape bool
}

// Schema is everything read from the schema directory.
type Schema struct {
	// Document is the generated schema with its conditional step union swapped
	// for the envelope. Steps are checked one branch at a time afterwards,
	// because a validator that reports every unselected branch reports four
	// problems where there is one.
	Document        map[string]any
	Defs            map[string]any
	Actions         map[string]*Action
	ActionNames     []string
	AssertOperators []string
	StepCommonKeys  []string
}

// Load reads suite.schema.json and actions.catalog.yaml from one directory.
func Load(schemaRoot string) (*Schema, error) {
	schemaPath := filepath.Join(schemaRoot, "suite.schema.json")
	catalogPath := filepath.Join(schemaRoot, "actions.catalog.yaml")
	for _, path := range []string{schemaPath, catalogPath} {
		if info, err := os.Stat(path); err != nil || info.IsDir() {
			return nil, fmt.Errorf("Suite schema not found at %s. Generate it with the spec's Build-Schema.ps1 -Catalog <catalog>.", path)
		}
	}

	schemaText, err := os.ReadFile(schemaPath)
	if err != nil {
		return nil, fmt.Errorf("%s cannot be read: %w", schemaPath, err)
	}
	var document map[string]any
	if err := json.Unmarshal(schemaText, &document); err != nil {
		return nil, fmt.Errorf("%s is not JSON: %w", schemaPath, err)
	}

	defs, _ := document["$defs"].(map[string]any)
	if defs == nil {
		return nil, fmt.Errorf("suite.schema.json carries no $defs.")
	}
	envelope, found := defs["stepEnvelope"]
	if !found {
		return nil, fmt.Errorf("suite.schema.json carries no stepEnvelope definition.")
	}
	assertOperators := []string{}
	for _, name := range propertyNames(defs["assert"]) {
		if name != "var" {
			assertOperators = append(assertOperators, name)
		}
	}
	stepCommonKeys := propertyNames(defs["stepCommon"])
	defs["step"] = envelope

	entries, err := catalogEntries(catalogPath, nil)
	if err != nil {
		return nil, err
	}

	actions := map[string]*Action{}
	declaredIn := map[string]string{}
	for _, entry := range entries {
		held := entry.entry
		name, ok := held.Value("name").(string)
		if !ok || name == "" {
			continue
		}
		if first, taken := declaredIn[name]; taken {
			return nil, fmt.Errorf("Action %s is declared twice: in %s and in %s.", name, first, entry.file)
		}
		declaredIn[name] = entry.file
		params := []string{}
		declaredParams, _ := held.Value("params").([]any)
		for _, param := range declaredParams {
			shape, ok := param.(*model.Map)
			if !ok {
				continue
			}
			if paramName, ok := shape.Value("name").(string); ok {
				params = append(params, paramName)
			}
		}
		captures, hasShape := held.Get("captures")
		actions[name] = &Action{
			Name:          name,
			Bindings:      stringList(held.Value("bindings")),
			Interruptible: boolOr(held.Value("interruptible"), true),
			Deprecated:    boolOr(held.Value("deprecated"), false),
			Params:        params,
			Captures:      captures,
			HasShape:      hasShape && captures != nil,
		}
	}
	names := make([]string, 0, len(actions))
	for name := range actions {
		names = append(names, name)
	}
	sort.Strings(names)

	return &Schema{
		Document:        document,
		Defs:            defs,
		Actions:         actions,
		ActionNames:     names,
		AssertOperators: assertOperators,
		StepCommonKeys:  stepCommonKeys,
	}, nil
}

// catalogEntry is one action entry of a catalog, and the file it is in.
type catalogEntry struct {
	entry *model.Map
	file  string
}

// catalogEntries is every action entry of a catalog and of the catalogs it
// imports: imports first, depth first in listed order, each relative to the
// file that names it; then the catalog's own. visiting is the chain of
// catalogs being read, which is how a cycle is seen.
func catalogEntries(file string, visiting []string) ([]catalogEntry, error) {
	key, err := filepath.Abs(file)
	if err != nil {
		key = file
	}
	for _, held := range visiting {
		if strings.EqualFold(held, key) {
			return nil, fmt.Errorf("Catalog import cycle: %s", strings.Join(append(append([]string(nil), visiting...), key), " -> "))
		}
	}
	text, err := os.ReadFile(key)
	if err != nil {
		return nil, fmt.Errorf("%s cannot be read: %w", file, err)
	}
	catalog, err := model.Load(string(text))
	if err != nil {
		return nil, fmt.Errorf("%s is not YAML: %w", file, err)
	}
	root, _ := catalog.Value.(*model.Map)
	if root == nil {
		root = model.NewMap()
	}
	out := []catalogEntry{}
	chain := append(append([]string(nil), visiting...), key)
	for _, raw := range stringList(root.Value("imports")) {
		imported := raw
		if !filepath.IsAbs(imported) {
			imported = filepath.Join(filepath.Dir(key), filepath.FromSlash(raw))
		}
		if info, err := os.Stat(imported); err != nil || info.IsDir() {
			return nil, fmt.Errorf("%s imports %s, which does not exist (%s).", file, raw, imported)
		}
		found, err := catalogEntries(imported, chain)
		if err != nil {
			return nil, err
		}
		out = append(out, found...)
	}
	list, _ := root.Value("actions").([]any)
	for _, raw := range list {
		if held, ok := raw.(*model.Map); ok {
			out = append(out, catalogEntry{entry: held, file: key})
		}
	}
	return out, nil
}

// propertyNames is the properties one definition declares, sorted, because Go
// randomises map iteration and a suggestion list must not be random.
func propertyNames(definition any) []string {
	held, ok := definition.(map[string]any)
	if !ok {
		return nil
	}
	properties, ok := held["properties"].(map[string]any)
	if !ok {
		return nil
	}
	names := make([]string, 0, len(properties))
	for name := range properties {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func stringList(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

func boolOr(value any, fallback bool) bool {
	if held, ok := value.(bool); ok {
		return held
	}
	return fallback
}

// Has says whether the catalog declares an action.
func (loaded *Schema) Has(name string) bool {
	_, found := loaded.Actions[name]
	return found
}

// WithOverlay is the same schema with a corpus catalog overlay merged into it.
//
// An overlay exists so a rule the catalog drives - a deprecated action, a
// parameter the shipped catalog does not declare - can be proved without
// changing the catalog every binding reads. Merge by action name: each key
// given replaces the key in the shipped catalog, and a params entry replaces
// the one with the same name or is appended when there is none.
//
// The generated step branch is patched alongside the catalog, because the
// structural pass checks a step against #/$defs/step.<action> and the catalog
// is what that branch was generated from. Regenerating it in full would mean
// running the generator, which is a PowerShell script; adding the parameter the
// overlay declares is the part of that generation an overlay can change.
func WithOverlay(base *Schema, overlay any) (*Schema, error) {
	copied, err := base.clone()
	if err != nil {
		return nil, err
	}
	held, ok := overlay.(*model.Map)
	if !ok {
		return copied, nil
	}
	patches, _ := held.Value("actions").([]any)
	for _, raw := range patches {
		patch, ok := raw.(*model.Map)
		if !ok {
			continue
		}
		name, ok := patch.Value("name").(string)
		if !ok || name == "" {
			continue
		}
		action, found := copied.Actions[name]
		if !found {
			return nil, fmt.Errorf("The overlay patches %s, which the catalog does not declare.", name)
		}
		if deprecated, ok := patch.Value("deprecated").(bool); ok {
			action.Deprecated = deprecated
		}
		if patch.Has("bindings") {
			action.Bindings = stringList(patch.Value("bindings"))
		}
		if interruptible, ok := patch.Value("interruptible").(bool); ok {
			action.Interruptible = interruptible
		}
		added, _ := patch.Value("params").([]any)
		for _, raw := range added {
			declaration, ok := raw.(*model.Map)
			if !ok {
				continue
			}
			paramName, ok := declaration.Value("name").(string)
			if !ok || paramName == "" {
				continue
			}
			if !contains(action.Params, paramName) {
				action.Params = append(action.Params, paramName)
			}
			branch, _ := copied.Defs["step."+name].(map[string]any)
			properties, _ := branch["properties"].(map[string]any)
			if properties == nil {
				continue
			}
			shape := map[string]any{}
			if kind, found := declaration.Get("type"); found {
				shape["type"] = kind
			}
			if description, found := declaration.Get("description"); found {
				shape["description"] = description
			}
			properties[paramName] = shape
		}
	}
	// The document carries its own copy of the definitions, and the structural
	// pass reads that one.
	copied.Document["$defs"] = copied.Defs
	return copied, nil
}

// clone copies the schema deeply enough that patching one does not patch the
// other. The document goes through JSON because it arrived that way, and
// because a hand-written walk of every nested map is the kind of code that
// silently misses a case.
func (loaded *Schema) clone() (*Schema, error) {
	text, err := json.Marshal(loaded.Document)
	if err != nil {
		return nil, err
	}
	var document map[string]any
	if err := json.Unmarshal(text, &document); err != nil {
		return nil, err
	}
	defs, _ := document["$defs"].(map[string]any)
	actions := make(map[string]*Action, len(loaded.Actions))
	for name, action := range loaded.Actions {
		copied := *action
		copied.Bindings = append([]string(nil), action.Bindings...)
		copied.Params = append([]string(nil), action.Params...)
		actions[name] = &copied
	}
	return &Schema{
		Document:        document,
		Defs:            defs,
		Actions:         actions,
		ActionNames:     append([]string(nil), loaded.ActionNames...),
		AssertOperators: append([]string(nil), loaded.AssertOperators...),
		StepCommonKeys:  append([]string(nil), loaded.StepCommonKeys...),
	}, nil
}

func contains(list []string, wanted string) bool {
	for _, item := range list {
		if item == wanted {
			return true
		}
	}
	return false
}
