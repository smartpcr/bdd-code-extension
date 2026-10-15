// E201 to E213: what a schema cannot see.
//
// Duplicate names, limits and their ceilings, meta steps and their cycles,
// imports and what they shadow, parameters with no value anywhere, the Gherkin
// keyword order and the table rules. All of it needs the parsed model and the
// catalog rather than the file, which is why it is its own level (DEC-Y05).

package validate

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/spelling"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/diag"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/schema"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/value"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

// libraryKeys is everything a library may declare. Anything else runs, and a
// library does not run (DEC-Y17).
var libraryKeys = []string{"params", "vars", "metaSteps", "defaults", "description", "schemaVersion"}

// The ceiling on any limit. A runtime extension may add a stricter rule of its
// own (extension.Rules).
const limitCeilingSec = 14400

var gherkinKeywords = []string{"given", "when", "then", "and"}

// metaDefinition is what one meta step is, and where it is written.
type metaDefinition struct {
	definition *model.Map
	pointer    string
}

// Library is what a suite's imports contribute, and what they collide with.
type Library struct {
	Params      map[string]ParamDeclaration
	Vars        map[string]string
	MetaSteps   map[string]*model.Map
	Defaults    map[string]string
	Collisions  []Collision
	Diagnostics []diag.Diagnostic
	// Imports is every import the suite names that was found, in reading
	// order, for an extension's rules (extension.RuleInput).
	Imports []extension.Import
}

// ParamDeclaration is whether a parameter has a value anywhere, and where it
// was declared.
type ParamDeclaration struct {
	HasValue bool
	Pointer  string
}

// Collision is a local declaration that reuses an imported name.
type Collision struct {
	Kind    string
	Name    string
	Source  string
	Pointer string
}

func newLibrary() *Library {
	return &Library{
		Params:    map[string]ParamDeclaration{},
		Vars:      map[string]string{},
		MetaSteps: map[string]*model.Map{},
		Defaults:  map[string]string{},
	}
}

func mapKeys(held *model.Map, key string) []string {
	nested, ok := walk.AsMap(held.Value(key))
	if !ok {
		return nil
	}
	return nested.Keys()
}

func entriesOf(held *model.Map, key string) []*model.Map {
	items, _ := walk.List(held, key)
	out := make([]*model.Map, 0, len(items))
	for _, raw := range items {
		found, ok := walk.AsMap(raw)
		if !ok {
			// A blank entry keeps its index so that a pointer still lands where
			// it was written.
			out = append(out, nil)
			continue
		}
		out = append(out, found)
	}
	return out
}

func present(held *model.Map, key string) bool {
	if held == nil {
		return false
	}
	found, exists := held.Get(key)
	return exists && found != nil
}

func sortedKeys(held map[string]string) []string {
	names := make([]string, 0, len(held))
	for name := range held {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Imports reads the libraries a suite imports, depth first and in order.
func Imports(document *model.Document, file, filePath string) *Library {
	library := newLibrary()
	suite, ok := document.Value.(*model.Map)
	if !ok {
		return library
	}
	visited := map[string]bool{}
	if full, err := filepath.Abs(filePath); err == nil {
		visited[strings.ToLower(full)] = true
	}
	directory := filepath.Dir(filePath)

	items, _ := walk.List(suite, "imports")
	for index, raw := range items {
		name, ok := raw.(string)
		if !ok || name == "" {
			continue
		}
		pointer := fmt.Sprintf("/imports/%d", index)
		position := document.At(pointer).Value
		path := filepath.Join(directory, name)
		full := path
		if resolved, err := filepath.Abs(path); err == nil {
			full = resolved
		}
		if visited[strings.ToLower(full)] {
			library.Diagnostics = append(library.Diagnostics, diag.NewError("E207", file, position,
				fmt.Sprintf("Import %s forms a cycle.", name)))
			continue
		}
		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			library.Diagnostics = append(library.Diagnostics, diag.NewError("E301", file, position,
				fmt.Sprintf("Import %s does not exist.", name)))
			continue
		}
		visited[strings.ToLower(full)] = true
		library.Imports = append(library.Imports, extension.Import{Import: name, Pointer: pointer, File: full})
		text, err := os.ReadFile(path)
		if err != nil {
			library.Diagnostics = append(library.Diagnostics, diag.NewError("E100", file, position,
				fmt.Sprintf("Import %s cannot be read: %v", name, err)))
			continue
		}
		loaded, err := model.Load(string(text))
		if err != nil {
			library.Diagnostics = append(library.Diagnostics, diag.NewError("E100", file, position,
				fmt.Sprintf("Import %s is not valid YAML: %v", name, err)))
			continue
		}
		imported, ok := loaded.Value.(*model.Map)
		if !ok {
			library.Diagnostics = append(library.Diagnostics, diag.NewError("E100", file, position,
				fmt.Sprintf("Import %s does not hold a YAML mapping.", name)))
			continue
		}
		for _, key := range imported.Keys() {
			if !containsText(libraryKeys, key) {
				library.Diagnostics = append(library.Diagnostics, diag.NewError("E211", file, position,
					fmt.Sprintf("Import %s declares %s. A library declares %s and nothing that runs.",
						name, key, strings.Join(libraryKeys, ", "))))
			}
		}
		for _, param := range entriesOf(imported, "params") {
			if param == nil {
				continue
			}
			library.Params[walk.Text(param, "name")] = ParamDeclaration{
				HasValue: present(param, "default") || present(param, "input"),
				Pointer:  pointer,
			}
		}
		for _, variable := range mapKeys(imported, "vars") {
			library.Vars[variable] = name
		}
		for _, meta := range entriesOf(imported, "metaSteps") {
			if meta != nil {
				library.MetaSteps[walk.Text(meta, "name")] = meta
			}
		}
		for _, key := range mapKeys(imported, "defaults") {
			library.Defaults[key] = name
		}
	}

	// A local declaration that reuses an imported name has to say so.
	for index, meta := range entriesOf(suite, "metaSteps") {
		if meta == nil {
			continue
		}
		name := walk.Text(meta, "name")
		if _, found := library.MetaSteps[name]; found && !present(meta, "override") {
			library.Collisions = append(library.Collisions, Collision{
				Kind: "Meta step", Name: name, Source: "library",
				Pointer: fmt.Sprintf("/metaSteps/%d/name", index),
			})
		}
	}
	for index, param := range entriesOf(suite, "params") {
		if param == nil {
			continue
		}
		name := walk.Text(param, "name")
		if _, found := library.Params[name]; found && !present(param, "override") {
			library.Collisions = append(library.Collisions, Collision{
				Kind: "Parameter", Name: name, Source: "library",
				Pointer: fmt.Sprintf("/params/%d/name", index),
			})
		}
	}
	for _, name := range mapKeys(suite, "vars") {
		if source, found := library.Vars[name]; found {
			library.Collisions = append(library.Collisions, Collision{
				Kind: "Variable", Name: name, Source: source,
				Pointer: "/vars/" + model.Escape(name),
			})
		}
	}
	return library
}

// metaDepth is how deep one meta step nests, or the cycle it is part of.
func metaDepth(name string, definitions map[string]metaDefinition, path *[]string) (int, []string) {
	for _, seen := range *path {
		if seen == name {
			cycle := append(append([]string(nil), *path...), name)
			return len(*path), cycle
		}
	}
	definition, found := definitions[name]
	if !found {
		return len(*path), nil
	}
	*path = append(*path, name)
	deepest := len(*path)
	for _, step := range entriesOf(definition.definition, "steps") {
		if step == nil {
			continue
		}
		used := walk.Text(step, "meta")
		if used == "" {
			continue
		}
		depth, cycle := metaDepth(used, definitions, path)
		if cycle != nil {
			*path = (*path)[:len(*path)-1]
			return depth, cycle
		}
		if depth > deepest {
			deepest = depth
		}
	}
	*path = (*path)[:len(*path)-1]
	return deepest, nil
}

// assertionShape is E204: an assertion that compares nothing, wherever it is
// written.
func assertionShape(
	assertions any,
	pointer, whereItIs string,
	loaded *schema.Schema,
	document *model.Document,
	file string,
) []diag.Diagnostic {
	found := []diag.Diagnostic{}
	list, ok := assertions.([]any)
	if !ok {
		return found
	}
	for index, raw := range list {
		assertion, ok := walk.AsMap(raw)
		if !ok {
			continue
		}
		operators := []string{}
		for _, key := range assertion.Keys() {
			if containsText(loaded.AssertOperators, key) {
				operators = append(operators, key)
			}
		}
		position := document.At(fmt.Sprintf("%s/%d", pointer, index)).Key
		switch {
		case len(operators) == 0 && present(assertion, "var"):
			found = append(found, diag.NewError("E204", file, position, fmt.Sprintf(
				"The assertion on %s in %s names a subject and no comparison, so it asserts nothing.",
				walk.Text(assertion, "var"), whereItIs)).
				Suggest("One of: "+strings.Join(loaded.AssertOperators, ", ")))
		case !present(assertion, "var") && !present(assertion, "script"):
			found = append(found, diag.NewError("E204", file, position,
				fmt.Sprintf("An assertion in %s names no subject. Add var, or use script.", whereItIs)))
		}
	}
	return found
}

// tableRules is E213: a table whose rows do not agree, or repeat.
func tableRules(table any, pointer, whereItIs string, document *model.Document, file string) []diag.Diagnostic {
	found := []diag.Diagnostic{}
	list, ok := table.([]any)
	if !ok {
		return found
	}
	filled := 0
	for _, row := range list {
		if row != nil {
			filled++
		}
	}
	if filled == 0 {
		return append(found, diag.NewError("E213", file, document.At(pointer).Key,
			fmt.Sprintf("The table on %s has no rows, so the step it drives would never run.", whereItIs)))
	}
	columns := walk.TableColumns(table)
	seen := map[string]int{}
	for index, raw := range list {
		if raw == nil {
			continue
		}
		row, ok := walk.AsMap(raw)
		if !ok {
			continue
		}
		rowColumns := row.Keys()
		missing := []string{}
		for _, column := range columns {
			if !containsText(rowColumns, column) {
				missing = append(missing, column)
			}
		}
		extra := []string{}
		for _, column := range rowColumns {
			if !containsText(columns, column) {
				extra = append(extra, column)
			}
		}
		position := document.At(fmt.Sprintf("%s/%d", pointer, index)).Key
		if len(missing) > 0 || len(extra) > 0 {
			parts := []string{}
			for _, name := range missing {
				parts = append(parts, name+" is missing")
			}
			for _, name := range extra {
				parts = append(parts, name+" is extra")
			}
			found = append(found, diag.NewError("E213", file, position, fmt.Sprintf(
				"Row %d of the table on %s does not declare the same columns as the first row: %s.",
				index+1, whereItIs, strings.Join(parts, ", "))))
		}
		sorted := append([]string(nil), rowColumns...)
		sort.Strings(sorted)
		parts := make([]string, 0, len(sorted))
		for _, column := range sorted {
			parts = append(parts, column+"="+value.Text(row.Value(column)))
		}
		signature := strings.Join(parts, "\x01")
		if first, repeated := seen[signature]; repeated {
			found = append(found, diag.NewError("E213", file, position, fmt.Sprintf(
				"Row %d of the table on %s repeats row %d, which would give two iterations the same name.",
				index+1, whereItIs, first)))
			continue
		}
		seen[signature] = index + 1
	}
	return found
}

// scenarioRules is E212, E213 and W304: the keywords are used in order, and a
// list is labelled all the way through or not at all.
func scenarioRules(document *model.Document, file string) []diag.Diagnostic {
	found := []diag.Diagnostic{}
	suite, ok := document.Value.(*model.Map)
	if !ok {
		return found
	}
	rank := func(keyword string) int {
		switch keyword {
		case "given":
			return 1
		case "when":
			return 2
		case "then":
			return 3
		default:
			return 0
		}
	}
	for _, list := range walk.StepLists(suite) {
		started := false
		highest := 0
		labelled := 0
		total := 0
		for index, raw := range list.Steps {
			step, ok := walk.AsMap(raw)
			if !ok {
				continue
			}
			stepPointer := fmt.Sprintf("%s/%d", list.Pointer, index)
			foundKeywords := []string{}
			for _, key := range step.Keys() {
				if containsText(gherkinKeywords, key) {
					foundKeywords = append(foundKeywords, key)
				}
			}
			// A meta use site with no keyword of its own stands for the steps of
			// its definition, and those carry theirs.
			if len(foundKeywords) > 0 || !present(step, "meta") {
				total++
			}
			if len(foundKeywords) > 1 {
				found = append(found, diag.NewError("E212", file,
					document.At(stepPointer+"/"+foundKeywords[1]).Key, fmt.Sprintf(
						"Step %d of %s carries %s. A step carries one Gherkin keyword.",
						index+1, list.Name, strings.Join(foundKeywords, " and "))))
			}
			if len(foundKeywords) > 0 {
				keyword := foundKeywords[0]
				labelled++
				if keyword == "and" {
					if !started {
						found = append(found, diag.NewError("E212", file,
							document.At(stepPointer+"/and").Key, fmt.Sprintf(
								"Step %d of %s is an and with nothing before it to continue.",
								index+1, list.Name)).
							Suggest("Start the list with given, when or then."))
					}
				} else {
					if rank(keyword) < highest {
						before := "then"
						switch highest {
						case 1:
							before = "given"
						case 2:
							before = "when"
						}
						found = append(found, diag.NewError("E212", file,
							document.At(stepPointer+"/"+keyword).Key, fmt.Sprintf(
								"Step %d of %s is a %s after a %s. The order is given, then when, then then.",
								index+1, list.Name, keyword, before)).
							Suggest("Continue with and, or move the step."))
					}
					if rank(keyword) > highest {
						highest = rank(keyword)
					}
					started = true
				}
			}
			if present(step, "table") {
				found = append(found, tableRules(step.Value("table"), stepPointer+"/table",
					fmt.Sprintf("step %d of %s", index+1, list.Name), document, file)...)
				if list.Case != nil && present(list.Case, "examples") {
					found = append(found, diag.NewError("E213", file,
						document.At(stepPointer+"/table").Key, fmt.Sprintf(
							"Step %d of %s carries a table inside a case that already carries examples. There is one row namespace, and two row scopes would shadow each other.",
							index+1, list.Name)).
						Suggest("Keep the table and drop the examples, or the other way round."))
				}
			}
		}
		if labelled > 0 && labelled < total {
			found = append(found, diag.NewWarning("W304", file, document.At(list.Pointer).Key, fmt.Sprintf(
				"%s labels %d of its %d steps with a Gherkin keyword. Label all of them or none.",
				list.Name, labelled, total)))
		}
	}
	for index, held := range entriesOf(suite, "tests") {
		if held == nil || !present(held, "examples") {
			continue
		}
		found = append(found, tableRules(held.Value("examples"),
			fmt.Sprintf("/tests/%d/examples", index),
			"case "+walk.Text(held, "name"), document, file)...)
	}
	return found
}

// limits is E205: every declared limit is a positive number under its
// ceiling. A runtime extension may add a stricter rule of its own.
func limits(document *model.Document, file string) []diag.Diagnostic {
	type limit struct {
		pointer string
		name    string
		value   any
		scope   string
	}
	found := []diag.Diagnostic{}
	suite, ok := document.Value.(*model.Map)
	if !ok {
		return found
	}
	declared := []limit{}
	for _, key := range []string{"setupTimeoutSec", "beforeEachTimeoutSec", "afterEachTimeoutSec", "teardownTimeoutSec"} {
		if present(suite, key) {
			declared = append(declared, limit{"/" + key, key, suite.Value(key), "the suite"})
		}
	}
	if defaults, ok := walk.AsMap(suite.Value("defaults")); ok {
		for _, key := range []string{"timeoutSec", "cleanupTimeoutSec"} {
			if present(defaults, key) {
				declared = append(declared, limit{"/defaults/" + key, key, defaults.Value(key), "the suite defaults"})
			}
		}
	}
	for index, held := range entriesOf(suite, "tests") {
		if held == nil {
			continue
		}
		for _, key := range []string{"timeoutSec", "cleanupTimeoutSec", "setupTimeoutSec"} {
			if present(held, key) {
				declared = append(declared, limit{
					fmt.Sprintf("/tests/%d/%s", index, key), key, held.Value(key),
					"case " + walk.Text(held, "name"),
				})
			}
		}
	}

	for _, one := range declared {
		ceiling := limitCeilingSec
		// A limit written as an expression is checked when it is evaluated, and
		// a limit of the wrong type has already been refused by the schema.
		seconds, ok := one.value.(int64)
		if !ok {
			continue
		}
		if seconds < 1 || seconds > int64(ceiling) {
			found = append(found, diag.NewError("E205", file, document.At(one.pointer).Value, fmt.Sprintf(
				"%s on %s is %d seconds, outside 1 to %d.", one.name, one.scope, seconds, ceiling)))
		}
	}

	return found
}

// checkSemantics is the semantic pass.
func checkSemantics(
	document *model.Document,
	file string,
	loaded *schema.Schema,
	library *Library,
	binding string,
	bindingCheck bool,
	commandLineParams [][2]string,
	envPrefix string,
) []diag.Diagnostic {
	found := []diag.Diagnostic{}
	suite, ok := document.Value.(*model.Map)
	if !ok {
		return found
	}

	// E202: two cases a report cannot tell apart.
	seenCase := map[string]bool{}
	for index, held := range entriesOf(suite, "tests") {
		if held == nil {
			continue
		}
		name := walk.Text(held, "name")
		if seenCase[name] {
			found = append(found, diag.NewError("E202", file,
				document.At(fmt.Sprintf("/tests/%d/name", index)).Value,
				fmt.Sprintf("Case %s is declared twice in this suite.", name)))
			continue
		}
		seenCase[name] = true
	}

	// E203: one case capturing the same name twice.
	for index, held := range entriesOf(suite, "tests") {
		if held == nil {
			continue
		}
		seenCapture := map[string]bool{}
		for _, phase := range walk.CasePhases {
			steps, _ := walk.List(held, phase)
			for _, entry := range walk.StepEntries(steps, fmt.Sprintf("/tests/%d/%s", index, phase), phase) {
				name := walk.Text(entry.Step, "captureAs")
				if name == "" {
					continue
				}
				if seenCapture[name] {
					found = append(found, diag.NewError("E203", file,
						document.At(entry.Pointer+"/captureAs").Value, fmt.Sprintf(
							"Case %s already captures %s. The second would replace the first.",
							walk.Text(held, "name"), name)))
					continue
				}
				seenCapture[name] = true
			}
		}
		found = append(found, assertionShape(held.Value("asserts"),
			fmt.Sprintf("/tests/%d/asserts", index),
			"case "+walk.Text(held, "name"), loaded, document, file)...)
	}
	for _, entry := range walk.AllSteps(suite) {
		found = append(found, assertionShape(entry.Step.Value("asserts"),
			entry.Pointer+"/asserts", "a "+entry.Phase+" step", loaded, document, file)...)
	}

	found = append(found, limits(document, file)...)
	found = append(found, scenarioRules(document, file)...)

	// E206, E207, E208: meta steps exist, do not form a cycle, and are used with
	// the parameters they declare.
	definitions := map[string]metaDefinition{}
	for index, meta := range entriesOf(suite, "metaSteps") {
		if meta == nil {
			continue
		}
		definitions[walk.Text(meta, "name")] = metaDefinition{meta, fmt.Sprintf("/metaSteps/%d", index)}
	}
	for _, name := range sortedMapKeys(library.MetaSteps) {
		if _, found := definitions[name]; !found {
			definitions[name] = metaDefinition{library.MetaSteps[name], ""}
		}
	}
	names := make([]string, 0, len(definitions))
	for name := range definitions {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, entry := range walk.AllSteps(suite) {
		used := walk.Text(entry.Step, "meta")
		if used == "" {
			continue
		}
		definition, exists := definitions[used]
		if !exists {
			finding := diag.NewError("E206", file, document.At(entry.Pointer+"/meta").Value,
				fmt.Sprintf("No meta step named %s is declared or imported.", used))
			found = append(found, finding.Suggest(spelling.Nearest(used, names, 2)))
			continue
		}
		declared := []string{}
		for _, param := range entriesOf(definition.definition, "params") {
			if param != nil {
				declared = append(declared, walk.Text(param, "name"))
			}
		}
		supplied := []string{}
		if with, ok := walk.AsMap(entry.Step.Value("with")); ok {
			supplied = with.Keys()
		}
		for _, param := range entriesOf(definition.definition, "params") {
			if param == nil {
				continue
			}
			name := walk.Text(param, "name")
			required, _ := param.Value("required").(bool)
			if required && !containsText(supplied, name) && !present(param, "default") {
				found = append(found, diag.NewError("E208", file,
					document.At(entry.Pointer+"/meta").Value, fmt.Sprintf(
						"Meta step %s requires the parameter %s, and this use site does not pass it.", used, name)))
			}
		}
		for _, name := range supplied {
			if containsText(declared, name) {
				continue
			}
			finding := diag.NewError("E208", file,
				document.At(entry.Pointer+"/with/"+model.Escape(name)).Key,
				fmt.Sprintf("Meta step %s declares no parameter %s.", used, name))
			found = append(found, finding.Suggest(spelling.Nearest(name, declared, 2)))
		}
	}
	for _, name := range names {
		path := []string{}
		depth, cycle := metaDepth(name, definitions, &path)
		pointer := definitions[name].pointer
		switch {
		case cycle != nil:
			found = append(found, diag.NewError("E207", file, document.At(pointer).Key,
				fmt.Sprintf("Meta step %s is part of a cycle: %s.", name, strings.Join(cycle, " uses "))))
		case depth > 5:
			found = append(found, diag.NewError("E207", file, document.At(pointer).Key,
				fmt.Sprintf("Meta step %s nests %d deep, and five is the limit.", name, depth)))
		}
	}

	// E209: a local declaration that silently shadows an imported one.
	for _, collision := range library.Collisions {
		found = append(found, diag.NewError("E209", file, document.At(collision.Pointer).Key,
			fmt.Sprintf("%s %s is already declared by the imported %s.",
				collision.Kind, collision.Name, collision.Source)).
			Suggest("Add override: true to say that the replacement is deliberate."))
	}
	found = append(found, library.Diagnostics...)

	// E210: a parameter with no value anywhere, and a --param nobody declared.
	declaredParams := map[string]ParamDeclaration{}
	for name, declaration := range library.Params {
		declaredParams[name] = declaration
	}
	for index, param := range entriesOf(suite, "params") {
		if param == nil {
			continue
		}
		declaredParams[walk.Text(param, "name")] = ParamDeclaration{
			HasValue: present(param, "default") || present(param, "value") || present(param, "input"),
			Pointer:  fmt.Sprintf("/params/%d", index),
		}
	}
	for caseIndex, held := range entriesOf(suite, "tests") {
		if held == nil {
			continue
		}
		for paramIndex, param := range entriesOf(held, "params") {
			if param == nil {
				continue
			}
			name := walk.Text(param, "name")
			existing, exists := declaredParams[name]
			if !exists {
				existing = ParamDeclaration{Pointer: fmt.Sprintf("/tests/%d/params/%d", caseIndex, paramIndex)}
			}
			if present(param, "value") || present(param, "default") || present(param, "input") {
				existing.HasValue = true
			}
			declaredParams[name] = existing
		}
	}
	given := map[string]bool{}
	for _, pair := range commandLineParams {
		given[pair[0]] = true
	}
	declaredNames := make([]string, 0, len(declaredParams))
	for name := range declaredParams {
		declaredNames = append(declaredNames, name)
	}
	sort.Strings(declaredNames)
	for _, name := range declaredNames {
		declaration := declaredParams[name]
		if declaration.HasValue || given[name] {
			continue
		}
		if _, set := os.LookupEnv(envPrefix + "PARAM_" + strings.ToUpper(name)); set {
			continue
		}
		found = append(found, diag.NewError("E210", file, document.At(declaration.Pointer).Key,
			fmt.Sprintf("Parameter %s has no value at any level and no default.", name)).
			Suggest(fmt.Sprintf("Give it a default, or pass --param %s=<value>.", name)))
	}
	for _, pair := range commandLineParams {
		if _, exists := declaredParams[pair[0]]; exists {
			continue
		}
		finding := diag.NewError("E210", file, document.At("").Key,
			fmt.Sprintf("--param %s names a parameter this suite does not declare.", pair[0]))
		found = append(found, finding.Suggest(spelling.Nearest(pair[0], declaredNames, 2)))
	}

	// E201 and W302: the action exists for the binding that was asked for, and
	// is not one the catalog has retired.
	for _, entry := range walk.AllSteps(suite) {
		action := walk.Text(entry.Step, "action")
		declaration, exists := loaded.Actions[action]
		if !exists {
			continue
		}
		position := document.At(entry.Pointer + "/action").Value
		if declaration.Deprecated {
			found = append(found, diag.NewWarning("W302", file, position,
				fmt.Sprintf("Action %s is marked deprecated in the catalog.", action)))
		}
		if bindingCheck && !containsText(declaration.Bindings, binding) {
			found = append(found, diag.NewError("E201", file, position, fmt.Sprintf(
				"The %s binding does not implement %s. Implemented by: %s.",
				binding, action, strings.Join(declaration.Bindings, ", "))))
		}
	}

	return found
}

func sortedMapKeys(held map[string]*model.Map) []string {
	names := make([]string, 0, len(held))
	for name := range held {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func containsText(list []string, wanted string) bool {
	for _, item := range list {
		if item == wanted {
			return true
		}
	}
	return false
}
