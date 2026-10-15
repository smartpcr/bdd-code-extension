// Package suite is one suite file as the runner executes it: meta steps
// expanded, tables and outlines turned into one step per row, parameters
// resolved, and every step carrying a label a report and a trace can print.
//
// Everything here happens before the first action runs. A file that expands
// cleanly is a file whose shape the run no longer has to think about.
package suite

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/expr"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/value"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

// metaDepthLimit is how deep a meta step may use another before it is a cycle
// rather than a nest, which is refused here rather than left to recurse.
const metaDepthLimit = 5

var gherkinKeywords = []string{"given", "when", "then", "and"}

// Library is what a suite's libraries contribute, in the order they were
// imported.
type Library struct {
	Params    []*model.Map
	Vars      *model.Map
	MetaSteps map[string]*model.Map
	Defaults  *model.Map
}

func newLibrary() *Library {
	return &Library{Vars: model.NewMap(), MetaSteps: map[string]*model.Map{}, Defaults: model.NewMap()}
}

func entries(held *model.Map, key string) []*model.Map {
	items, _ := walk.List(held, key)
	out := make([]*model.Map, 0, len(items))
	for _, raw := range items {
		if found, ok := walk.AsMap(raw); ok {
			out = append(out, found)
		}
	}
	return out
}

// ReadLibraries reads the libraries a suite imports, depth first and in order.
//
// What a library imports is in scope before the library's own declarations, so
// the nearer file wins. A cycle is refused rather than recursed into.
func ReadLibraries(suite *model.Map, filePath string) (*Library, error) {
	library := newLibrary()
	visited := map[string]bool{strings.ToLower(absolute(filePath)): true}
	if err := walkImports(suite, filePath, visited, library); err != nil {
		return nil, err
	}
	return library, nil
}

func absolute(path string) string {
	if full, err := filepath.Abs(path); err == nil {
		return full
	}
	return path
}

func walkImports(suite *model.Map, filePath string, visited map[string]bool, library *Library) error {
	directory := filepath.Dir(filePath)
	items, _ := walk.List(suite, "imports")
	for _, raw := range items {
		name, ok := raw.(string)
		if !ok || name == "" {
			continue
		}
		path := filepath.Join(directory, name)
		full := strings.ToLower(absolute(path))
		if visited[full] {
			return fmt.Errorf("Import %s forms a cycle.", name)
		}
		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			return fmt.Errorf("Import %s does not exist at %s.", name, path)
		}
		visited[full] = true
		text, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("Import %s cannot be read: %w", name, err)
		}
		loaded, err := model.Load(string(text))
		if err != nil {
			return fmt.Errorf("Import %s is not valid YAML: %w", name, err)
		}
		imported, ok := loaded.Value.(*model.Map)
		if !ok {
			return fmt.Errorf("Import %s does not hold a YAML mapping.", name)
		}
		if err := walkImports(imported, path, visited, library); err != nil {
			return err
		}
		library.Params = append(library.Params, entries(imported, "params")...)
		if vars, ok := walk.AsMap(imported.Value("vars")); ok {
			for _, key := range vars.Keys() {
				library.Vars.Set(key, vars.Value(key))
			}
		}
		for _, meta := range entries(imported, "metaSteps") {
			library.MetaSteps[walk.Text(meta, "name")] = meta
		}
		if defaults, ok := walk.AsMap(imported.Value("defaults")); ok {
			for _, key := range defaults.Keys() {
				library.Defaults.Set(key, defaults.Value(key))
			}
		}
	}
	return nil
}

// MetaDefinitions is every meta step in scope, indexed by name. A local
// declaration wins.
func MetaDefinitions(suite *model.Map, library *Library) map[string]*model.Map {
	definitions := map[string]*model.Map{}
	for name, meta := range library.MetaSteps {
		definitions[name] = meta
	}
	for _, meta := range entries(suite, "metaSteps") {
		definitions[walk.Text(meta, "name")] = meta
	}
	return definitions
}

// bindMetaParams substitutes ${param.x} inside a meta step's body, leaving a
// name the use site has no value for alone: the dataflow pass is what reports
// it, with a position.
func bindMetaParams(held any, arguments *model.Map) any {
	switch found := held.(type) {
	case string:
		out := found
		for _, name := range arguments.Keys() {
			out = strings.ReplaceAll(out, "${param."+name+"}", value.Text(arguments.Value(name)))
		}
		return out
	case []any:
		out := make([]any, 0, len(found))
		for _, item := range found {
			out = append(out, bindMetaParams(item, arguments))
		}
		return out
	case *model.Map:
		out := model.NewMap()
		for _, key := range found.Keys() {
			out.Set(key, bindMetaParams(found.Value(key), arguments))
		}
		return out
	default:
		return held
	}
}

// FormatRow is one row as the text a report entry carries: column=value, in
// order.
func FormatRow(row any) string {
	held, ok := walk.AsMap(row)
	if !ok {
		return ""
	}
	parts := make([]string, 0, held.Len())
	for _, column := range held.Keys() {
		parts = append(parts, column+"="+value.Text(held.Value(column)))
	}
	return strings.Join(parts, ", ")
}

// StepLabel is what the trace and a failure call one step.
//
// The sentence first when the step has one, because that is what says what the
// step means; the action in brackets, because that is what ran; the row last,
// because the sentence says what the step means and the row says which of them
// this is.
func StepLabel(step *model.Map) string {
	action := walk.Text(step, "action")
	row := ""
	if index, ok := step.Value("__rowIndex").(int64); ok {
		row = fmt.Sprintf(" row %d (%s)", index, FormatRow(step.Value("__row")))
	}
	keyword := walk.Text(step, "__keyword")
	sentence := walk.Text(step, "__sentence")
	if keyword != "" && sentence != "" {
		return fmt.Sprintf("%s %s (%s)%s", keyword, sentence, action, row)
	}
	if provenance := walk.Text(step, "__provenance"); provenance != "" {
		return fmt.Sprintf("%s (%s)%s", provenance, action, row)
	}
	return fmt.Sprintf("step %s%s", action, row)
}

// resolveKeyword lifts a step's Gherkin keyword and sentence onto it, so
// nothing after this has to know which of the four keys carried it.
//
// DEC-Y22: an `and` becomes the keyword it continues, once, here. The sentence
// stays the step's own; only the keyword is inherited, because a report that
// said `and` on its own would not say whether the step establishes something,
// exercises it or observes it.
func resolveKeyword(step *model.Map, previous *string) {
	for _, keyword := range []string{"given", "when", "then"} {
		if walk.Text(step, keyword) != "" {
			*previous = keyword
		}
	}
	if continued := walk.Text(step, "and"); continued != "" {
		keyword := *previous
		if keyword == "" {
			keyword = "and"
		}
		step.Set("__keyword", keyword)
		step.Set("__sentence", continued)
		return
	}
	for _, keyword := range gherkinKeywords {
		if sentence := walk.Text(step, keyword); sentence != "" {
			step.Set("__keyword", keyword)
			step.Set("__sentence", sentence)
			return
		}
	}
}

// ExpandSteps is one step list, with every meta use site replaced by the steps
// it stands for and every table replaced by one step per row.
func ExpandSteps(
	steps []any,
	definitions map[string]*model.Map,
	whereItIs string,
	depth int,
	provenance string,
) ([]*model.Map, error) {
	expanded := []*model.Map{}
	// The keyword an `and` continues, tracked across this list only: a case's
	// steps are one scenario and its cleanup is not part of it.
	previous := ""
	for index, raw := range steps {
		step, ok := walk.AsMap(raw)
		if !ok {
			continue
		}
		position := fmt.Sprintf("step %d", index+1)
		if provenance != "" {
			position = fmt.Sprintf("%s step %d", provenance, index+1)
		}

		if used := walk.Text(step, "meta"); used != "" {
			definition, found := definitions[used]
			if !found {
				return nil, fmt.Errorf(
					"%s %s uses meta step %s, which is not declared or imported.", whereItIs, position, used)
			}
			if depth >= metaDepthLimit {
				return nil, fmt.Errorf(
					"%s %s nests meta steps deeper than %d, which is the limit. A meta step that uses itself, directly or through another, is a cycle.",
					whereItIs, position, metaDepthLimit)
			}
			arguments := model.NewMap()
			for _, declared := range entries(definition, "params") {
				if held, found := declared.Get("default"); found && held != nil {
					arguments.Set(walk.Text(declared, "name"), held)
				}
			}
			if with, ok := walk.AsMap(step.Value("with")); ok {
				for _, key := range with.Keys() {
					arguments.Set(key, with.Value(key))
				}
			}
			body, _ := walk.List(definition, "steps")
			bound := make([]any, 0, len(body))
			for _, inner := range body {
				bound = append(bound, bindMetaParams(inner, arguments))
			}
			guard := walk.Text(step, "ifCapture")
			inner, err := ExpandSteps(bound, definitions, whereItIs, depth+1, "meta "+used)
			if err != nil {
				return nil, err
			}
			for _, one := range inner {
				// A nested step that carries a guard from the use site inherits
				// it, so `- meta: x` with ifCapture skips the whole group.
				if guard != "" && walk.Text(one, "ifCapture") == "" {
					one.Set("ifCapture", guard)
				}
				expanded = append(expanded, one)
			}
			continue
		}

		if table, found := step.Get("table"); found && table != nil {
			rows, _ := table.([]any)
			for rowIndex, row := range rows {
				copied := step.Clone()
				copied.Delete("table")
				copied.Set("__row", row)
				copied.Set("__rowIndex", int64(rowIndex+1))
				copied.Set("__rowCount", int64(len(rows)))
				copied.Set("__provenance", position)
				resolveKeyword(copied, &previous)
				expanded = append(expanded, copied)
			}
			continue
		}

		copied := step.Clone()
		copied.Set("__provenance", position)
		resolveKeyword(copied, &previous)
		expanded = append(expanded, copied)
	}
	return expanded, nil
}

// ExpandOutline is one case per row of its examples block, named by the row.
func ExpandOutline(held *model.Map) []*model.Map {
	examples, found := held.Get("examples")
	rows, _ := examples.([]any)
	if !found || examples == nil || len(rows) == 0 {
		return []*model.Map{held}
	}
	name := walk.Text(held, "name")
	out := make([]*model.Map, 0, len(rows))
	for _, row := range rows {
		copied := held.Clone()
		copied.Delete("examples")
		copied.Set("name", fmt.Sprintf("%s [%s]", name, FormatRow(row)))
		copied.Set("__row", row)
		out = append(out, copied)
	}
	return out
}

// ResolveParams is the value each declared parameter takes, highest source
// first.
//
// DEC-Y18, in this order: the command line, the environment, the case, the
// file, the library. Every level is checked so that the answer is the same
// whichever level happens to hold a value.
//
// The environment variable is <envPrefix>PARAM_<NAME>; envPrefix is the
// composite's (BDD_SUITE_ unless an extension sets another).
func ResolveParams(library *Library, suite *model.Map, held *model.Map, commandLine [][2]string, envPrefix string) *model.Map {
	values := model.NewMap()
	take := func(declared *model.Map) {
		name := walk.Text(declared, "name")
		if name == "" {
			return
		}
		if found, ok := declared.Get("default"); ok && found != nil {
			values.Set(name, found)
		}
		if found, ok := declared.Get("value"); ok && found != nil {
			values.Set(name, found)
		}
	}
	declarations := append([]*model.Map(nil), library.Params...)
	declarations = append(declarations, entries(suite, "params")...)
	fileLevel := len(declarations)
	if held != nil {
		declarations = append(declarations, entries(held, "params")...)
	}
	for _, declared := range declarations {
		take(declared)
	}
	names := values.Keys()
	for _, declared := range declarations[:fileLevel] {
		name := walk.Text(declared, "name")
		if name != "" && !containsText(names, name) {
			names = append(names, name)
		}
	}
	for _, name := range names {
		if found, set := os.LookupEnv(envPrefix + "PARAM_" + strings.ToUpper(name)); set {
			values.Set(name, found)
		}
	}
	for _, pair := range commandLine {
		values.Set(pair[0], pair[1])
	}
	return values
}

// ResolveVars is the variables a case sees: the library's, the suite's, then
// its own, each evaluated once against everything already in scope.
//
// roots is the roots a path may start at (the core's and every extension's
// context keys); the core's when empty.
func ResolveVars(library *Library, suite *model.Map, held *model.Map, scope *model.Map, roots ...string) error {
	sources := []*model.Map{library.Vars}
	if vars, ok := walk.AsMap(suite.Value("vars")); ok {
		sources = append(sources, vars)
	}
	if held != nil {
		if vars, ok := walk.AsMap(held.Value("vars")); ok {
			sources = append(sources, vars)
		}
	}
	bag, ok := walk.AsMap(scope.Value("var"))
	if !ok {
		bag = model.NewMap()
		scope.Set("var", bag)
	}
	for _, source := range sources {
		for _, name := range source.Keys() {
			resolved, err := expr.Expand(source.Value(name), expr.NewScope(scope, roots...))
			if err != nil {
				return err
			}
			bag.Set(name, resolved)
		}
	}
	return nil
}

// TagsMatch says whether a case is selected by a tag filter.
func TagsMatch(caseTags, filter []string) bool {
	if len(filter) == 0 {
		return true
	}
	for _, tag := range caseTags {
		if containsText(filter, tag) {
			return true
		}
	}
	return false
}

// CaseTags is every tag that applies to a case: its own and the suite's.
func CaseTags(suite *model.Map, held *model.Map) []string {
	tags := []string{}
	for _, source := range []*model.Map{held, suite} {
		items, _ := walk.List(source, "tags")
		for _, raw := range items {
			if tag, ok := raw.(string); ok {
				tags = append(tags, tag)
			}
		}
	}
	return tags
}

// ExpandedCase is every step list of one case, expanded, in the order the
// phases run.
func ExpandedCase(held *model.Map, definitions map[string]*model.Map) (map[string][]*model.Map, error) {
	phases := map[string][]*model.Map{}
	for _, phase := range walk.CasePhases {
		steps, _ := walk.List(held, phase)
		expanded, err := ExpandSteps(steps, definitions, "case "+walk.Text(held, "name"), 0, "")
		if err != nil {
			return nil, err
		}
		phases[phase] = expanded
	}
	return phases, nil
}

// ExpandedHooks is the suite's own hook lists, expanded.
func ExpandedHooks(suite *model.Map, definitions map[string]*model.Map) (map[string][]*model.Map, error) {
	hooks := map[string][]*model.Map{}
	for _, hook := range walk.Hooks {
		steps, _ := walk.List(suite, hook)
		expanded, err := ExpandSteps(steps, definitions, "the suite "+hook, 0, "")
		if err != nil {
			return nil, err
		}
		hooks[hook] = expanded
	}
	return hooks, nil
}

// Cases is every case a file runs, outlines expanded.
func Cases(suite *model.Map) []*model.Map {
	found := []*model.Map{}
	for _, held := range entries(suite, "tests") {
		found = append(found, ExpandOutline(held)...)
	}
	return found
}

// StepLimit is one step's own limit, or what remains of the case, whichever is
// smaller.
//
// The innermost number wins and never raises: a step may shorten its share of
// the case's budget and may never lengthen it (DEC-Y08).
func StepLimit(ownSec, remainingSec int64) int64 {
	if ownSec > 0 && ownSec < remainingSec {
		return ownSec
	}
	if ownSec > 0 {
		return remainingSec
	}
	return remainingSec
}

// Text reads one key of a mapping as text.
func Text(held *model.Map, key string) string { return walk.Text(held, key) }

func containsText(list []string, wanted string) bool {
	for _, item := range list {
		if item == wanted {
			return true
		}
	}
	return false
}

// SortedNames is a map's keys in one order, for anything that iterates them.
func SortedNames[Value any](held map[string]Value) []string {
	names := make([]string, 0, len(held))
	for name := range held {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
