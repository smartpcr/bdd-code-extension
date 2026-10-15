// E301 to E309, W301 and W303: every reference resolves, every path into a
// capture is one the action declares, and nothing is captured for nobody.
//
// This pass needs the case expanded - the suite setup, the hooks and the case's
// own phases in the order they run - because whether a capture exists yet
// depends on when the step that produces it runs.

package validate

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/assertion"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/spelling"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/diag"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/expr"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/schema"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

// coreContextKeys is the bare names the core's run context holds that are not a
// bag of their own; extensions add their own context keys.
var coreContextKeys = []string{"timeoutSec", "defaults"}

// produced says where a capture comes from, and when.
type produced struct {
	order   int64
	action  string
	pointer string
	// list is set when the step carries a table: it runs once per row and
	// publishes a list, so a path into that capture starts with an index
	// (DEC-Y23).
	list bool
}

// check is one value to look for references in, and what is in scope where it
// is.
type check struct {
	value   any
	pointer string
	order   int64
	inMeta  bool
	columns []string
}

// casePlan is one case as the ordered phases the runner executes it in.
func casePlan(suite *model.Map, held *model.Map, caseIndex int) []walk.StepEntry {
	plan := []walk.StepEntry{}
	add := func(owner *model.Map, key, pointer, phase string, base int64) {
		steps, _ := walk.List(owner, key)
		for _, entry := range walk.StepEntries(steps, pointer, phase) {
			entry.Order += base
			plan = append(plan, entry)
		}
	}
	add(suite, "setup", "/setup", "suite setup", -4000)
	add(suite, "beforeEach", "/beforeEach", "beforeEach", -3000)
	add(held, "setup", fmt.Sprintf("/tests/%d/setup", caseIndex), "case setup", -2000)
	add(held, "steps", fmt.Sprintf("/tests/%d/steps", caseIndex), "steps", 0)
	add(held, "cleanup", fmt.Sprintf("/tests/%d/cleanup", caseIndex), "cleanup", 100000)
	add(suite, "afterEach", "/afterEach", "afterEach", 200000)
	// The suite teardown is deliberately absent: it runs once, after the last
	// case, and reads the suite bag rather than any case copy (design 5.3).
	return plan
}

// shapeResult is what a walk into a declared capture shape found.
type shapeResult struct {
	ok         bool
	expected   string
	candidates []string
}

// walkShape is E302: a dotted path has to exist in the shape its action
// declares.
//
// The walk stops as soon as the shape is open or untyped, which is the honest
// answer for an API response: the path may well be there, and the catalog is
// not the place that knows.
func walkShape(shape any, segments []string) shapeResult {
	open := shapeResult{ok: true}
	current := shape
	for _, segment := range segments {
		if current == nil {
			return open
		}
		node, ok := walk.AsMap(current)
		if !ok {
			return open
		}
		kind := walk.Text(node, "type")
		if kind == "" || kind == "any" {
			return open
		}
		if kind == "array" {
			if _, err := strconv.Atoi(segment); err != nil && segment != "<index>" {
				return shapeResult{expected: "an index into an array"}
			}
			current = node.Value("items")
			continue
		}
		if kind != "object" {
			return shapeResult{expected: fmt.Sprintf("a %s, which has no %s inside it", kind, segment)}
		}
		// Truthy, not merely present. "additionalProperties: false" is the
		// catalog saying the shape is closed, and reading it as "there is
		// something here" would stop the walk at every closed object.
		if isOpen, _ := node.Value("additionalProperties").(bool); isOpen {
			return open
		}
		properties, _ := walk.AsMap(node.Value("properties"))
		declared := properties.Keys()
		if !containsText(declared, segment) {
			return shapeResult{expected: "not declared", candidates: declared}
		}
		current = properties.Value(segment)
	}
	return open
}

// subject is E301, E302 and the read that W301 counts, for one dotted subject.
func subject(
	text, pointer string,
	document *model.Document,
	file string,
	loaded *schema.Schema,
	sources map[string]produced,
	caseName string,
	read map[string]bool,
	atKey bool,
) []diag.Diagnostic {
	found := []diag.Diagnostic{}
	segments := strings.Split(text, ".")
	name := segments[0]
	read[name] = true
	node := document.At(pointer)
	position := node.Value
	if atKey {
		position = node.Key
	}
	source, exists := sources[name]
	if !exists {
		finding := diag.NewError("E301", file, position,
			fmt.Sprintf("No step in case %s captures %s.", caseName, name))
		return append(found, finding.Suggest(spelling.Nearest(name, sortedNames(sources), 2)))
	}
	declared, known := loaded.Actions[source.action]
	if !known {
		return found
	}
	var shape any = declared.Captures
	if source.list {
		wrapped := model.NewMap()
		wrapped.Set("type", "array")
		wrapped.Set("items", shape)
		shape = wrapped
	}
	if len(segments) <= 1 {
		return found
	}
	result := walkShape(shape, segments[1:])
	if result.ok {
		return found
	}
	finding := diag.NewError("E302", file, position,
		fmt.Sprintf("Action %s does not declare %s in what it captures.", source.action, text))
	switch {
	case len(result.candidates) == 0:
		// Nothing to suggest, so the shape says what it wanted instead.
		finding = finding.Suggest("That path wants " + result.expected + ".")
	default:
		last := segments[len(segments)-1]
		if nearest := spelling.Nearest(last, result.candidates, 2); nearest != "" {
			finding = finding.Suggest("Did you mean " + nearest)
		} else {
			finding = finding.Suggest("Declared: " + strings.Join(result.candidates, ", "))
		}
	}
	return append(found, finding)
}

// portablePattern is E308: a pattern outside the subset the four engines share.
func portablePattern(pattern, pointer string, document *model.Document, file string) []diag.Diagnostic {
	construct := assertion.Unportable(pattern)
	if construct == "" {
		return nil
	}
	return []diag.Diagnostic{diag.NewError("E308", file, document.At(pointer).Value,
		fmt.Sprintf("The pattern uses %s, which the Go binding's RE2 engine cannot run.", construct)).
		Suggest("Restrict the pattern to the subset RE2 and .NET agree on.")}
}

func sortedNames(sources map[string]produced) []string {
	names := make([]string, 0, len(sources))
	for name := range sources {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func sortedSet(held map[string]bool) []string {
	names := make([]string, 0, len(held))
	for name := range held {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// checkDataflow is the dataflow pass.
//
// extraContextKeys is every extension's context keys, which a path may also
// start at.
func checkDataflow(document *model.Document, file string, loaded *schema.Schema, library *Library, extraContextKeys []string) []diag.Diagnostic {
	contextKeys := append(append([]string(nil), coreContextKeys...), extraContextKeys...)
	found := []diag.Diagnostic{}
	suite, ok := document.Value.(*model.Map)
	if !ok {
		return found
	}

	declaredParams := map[string]bool{}
	for name := range library.Params {
		declaredParams[name] = true
	}
	for _, param := range entriesOf(suite, "params") {
		if param != nil {
			declaredParams[walk.Text(param, "name")] = true
		}
	}
	suiteVars := map[string]bool{}
	for name := range library.Vars {
		suiteVars[name] = true
	}
	for _, name := range mapKeys(suite, "vars") {
		suiteVars[name] = true
	}
	readParams := map[string]bool{}

	// Every capture name the file produces anywhere. A bare name that is one of
	// these is a reference written without its root, and the message can say
	// both halves of it.
	fileCaptures := map[string]bool{}
	for _, entry := range walk.AllSteps(suite) {
		if name := walk.Text(entry.Step, "captureAs"); name != "" {
			fileCaptures[name] = true
		}
	}

	for caseIndex, held := range entriesOf(suite, "tests") {
		if held == nil {
			continue
		}
		caseName := walk.Text(held, "name")
		plan := casePlan(suite, held, caseIndex)
		caseVars := map[string]bool{}
		for name := range suiteVars {
			caseVars[name] = true
		}
		for _, name := range mapKeys(held, "vars") {
			caseVars[name] = true
		}
		for _, param := range entriesOf(held, "params") {
			if param != nil {
				declaredParams[walk.Text(param, "name")] = true
			}
		}

		sources := map[string]produced{}
		for _, entry := range plan {
			name := walk.Text(entry.Step, "captureAs")
			if name == "" {
				continue
			}
			existing, exists := sources[name]
			if exists && entry.Order >= existing.order {
				continue
			}
			sources[name] = produced{
				order:   entry.Order,
				action:  walk.Text(entry.Step, "action"),
				pointer: entry.Pointer,
				list:    present(entry.Step, "table"),
			}
		}

		// A meta use site publishes what its definition exports, under the names
		// the definition gave them. The action is left blank because the export's
		// shape belongs to whichever step inside produced it, and a use site
		// cannot rename it (DEC-Y10).
		for _, entry := range plan {
			used := walk.Text(entry.Step, "meta")
			if used == "" {
				continue
			}
			var definition *model.Map
			for _, meta := range entriesOf(suite, "metaSteps") {
				if meta != nil && walk.Text(meta, "name") == used {
					definition = meta
					break
				}
			}
			if definition == nil {
				definition = library.MetaSteps[used]
			}
			if definition == nil {
				continue
			}
			exports, _ := walk.List(definition, "exports")
			for _, raw := range exports {
				name, ok := raw.(string)
				if !ok || name == "" {
					continue
				}
				sources[name] = produced{order: entry.Order, pointer: entry.Pointer}
			}
		}

		caseColumns := walk.TableColumns(held.Value("examples"))
		read := map[string]bool{}
		checks := []check{}
		for _, entry := range plan {
			columns := append([]string(nil), caseColumns...)
			columns = append(columns, walk.TableColumns(entry.Step.Value("table"))...)
			checks = append(checks, check{
				value:   entry.Step,
				pointer: entry.Pointer,
				order:   entry.Order,
				inMeta:  strings.HasPrefix(entry.Phase, "meta "),
				columns: columns,
			})
			guard := walk.Text(entry.Step, "ifCapture")
			if guard == "" {
				continue
			}
			if _, exists := sources[guard]; !exists {
				guard = strings.Split(guard, ".")[0]
			}
			// A guard may name a capture that is not there yet: that is the whole
			// point of it. So this is an existence check and never an ordering
			// one. A name no step in the case declares at all is a typo, and a
			// typo here silently disables a cleanup step.
			read[guard] = true
			if _, exists := sources[guard]; !exists {
				finding := diag.NewError("E301", file,
					document.At(entry.Pointer+"/ifCapture").Value, fmt.Sprintf(
						"ifCapture names %s, which no step in case %s captures.", guard, caseName))
				found = append(found, finding.Suggest(spelling.Nearest(guard, sortedNames(sources), 2)))
			}
		}

		// A case's own assertions read anything the case produced; a step's own
		// assertions read anything up to and including that step.
		addAssertions := func(assertions any, pointer string, order int64, columns []string, visible map[string]produced) []diag.Diagnostic {
			found := []diag.Diagnostic{}
			list, _ := assertions.([]any)
			for index, raw := range list {
				one, ok := walk.AsMap(raw)
				if !ok {
					continue
				}
				checks = append(checks, check{
					value:   one,
					pointer: fmt.Sprintf("%s/%d", pointer, index),
					order:   order,
					columns: columns,
				})
				if variable := walk.Text(one, "var"); variable != "" {
					found = append(found, subject(variable,
						fmt.Sprintf("%s/%d/var", pointer, index),
						document, file, loaded, visible, caseName, read, false)...)
				}
				if pattern := walk.Text(one, "matches"); pattern != "" {
					found = append(found, portablePattern(pattern,
						fmt.Sprintf("%s/%d/matches", pointer, index), document, file)...)
				}
				// A script assertion reads the bag directly, so what it names is
				// read even though it is not a ${...} reference.
				script := walk.Text(one, "script")
				pieces := strings.Split(script, "capture.")
				for _, piece := range pieces[min(1, len(pieces)):] {
					name := leadingName(piece)
					if name != "" {
						read[name] = true
					}
				}
			}
			return found
		}

		found = append(found, addAssertions(held.Value("asserts"),
			fmt.Sprintf("/tests/%d/asserts", caseIndex), 99999, caseColumns, sources)...)
		for _, entry := range plan {
			if !present(entry.Step, "asserts") {
				continue
			}
			// Inside a table step's own assertions the capture is that row's
			// result, not the list the step publishes afterwards.
			visible := map[string]produced{}
			for name, source := range sources {
				visible[name] = source
			}
			own := walk.Text(entry.Step, "captureAs")
			if present(entry.Step, "table") && own != "" {
				if source, exists := visible[own]; exists {
					source.list = false
					visible[own] = source
				}
			}
			columns := append([]string(nil), caseColumns...)
			columns = append(columns, walk.TableColumns(entry.Step.Value("table"))...)
			found = append(found, addAssertions(entry.Step.Value("asserts"),
				entry.Pointer+"/asserts", entry.Order+1, columns, visible)...)
		}

		for _, one := range checks {
			for _, reference := range expr.References(one.value, one.pointer) {
				position := document.At(reference.Pointer).Value
				reading := expr.Read(reference.Expression, false)
				if reading.Err != nil {
					finding := diag.NewError(reading.Err.Code, file, position, fmt.Sprintf(
						"${%s} does not parse: %s.", reference.Expression, reading.Err.Message))
					if reading.Err.Code == "E306" {
						if _, rest, cut := strings.Cut(reading.Err.Message, "Did you mean "); cut {
							finding = finding.Suggest("Did you mean " + strings.TrimRight(rest, "?."))
						}
					}
					found = append(found, finding)
					continue
				}
				for _, segments := range reading.Paths {
					whole := strings.Join(segments, ".")
					switch segments[0] {
					case "capture":
						if len(segments) < 2 {
							found = append(found, diag.NewError("E301", file, position,
								"A capture reference needs a name: ${capture.<name>}."))
							continue
						}
						name := segments[1]
						read[name] = true
						source, exists := sources[name]
						if !exists {
							finding := diag.NewError("E301", file, position,
								fmt.Sprintf("No step in case %s captures %s.", caseName, name))
							found = append(found, finding.Suggest(spelling.Nearest(name, sortedNames(sources), 2)))
							continue
						}
						if source.order >= one.order {
							found = append(found, diag.NewError("E303", file, position,
								fmt.Sprintf("Capture %s is read before the step that produces it.", name)))
							continue
						}
						found = append(found, subject(strings.Join(segments[1:], "."),
							reference.Pointer, document, file, loaded, sources, caseName, read, false)...)
					case "param":
						if len(segments) < 2 {
							continue
						}
						readParams[segments[1]] = true
						// A meta step's parameter is resolved at its use site.
						if one.inMeta {
							continue
						}
						if !declaredParams[segments[1]] {
							finding := diag.NewError("E301", file, position,
								fmt.Sprintf("No parameter named %s is declared or imported.", segments[1]))
							found = append(found, finding.Suggest(spelling.Nearest(segments[1], sortedSet(declaredParams), 2)))
						}
					case "var":
						if len(segments) < 2 {
							continue
						}
						if !caseVars[segments[1]] {
							finding := diag.NewError("E301", file, position,
								fmt.Sprintf("No variable named %s is declared.", segments[1]))
							found = append(found, finding.Suggest(spelling.Nearest(segments[1], sortedSet(caseVars), 2)))
						}
					case "defaults":
						if len(segments) < 2 {
							continue
						}
						if !containsText(mapKeys(suite, "defaults"), segments[1]) {
							found = append(found, diag.NewError("E301", file, position,
								fmt.Sprintf("The defaults block declares no %s.", segments[1])))
						}
					case "row":
						if len(one.columns) == 0 {
							found = append(found, diag.NewError("E301", file, position,
								"${row} has no table in scope. A row exists inside a step that carries a table, or a case that carries examples."))
							continue
						}
						if len(segments) < 2 {
							found = append(found, diag.NewError("E301", file, position,
								"A row reference needs a column: ${row.<column>}.").
								Suggest("Declared: "+strings.Join(one.columns, ", ")))
							continue
						}
						if !containsText(one.columns, segments[1]) {
							finding := diag.NewError("E301", file, position,
								fmt.Sprintf("The table in scope declares no column %s.", segments[1]))
							found = append(found, finding.Suggest(spelling.Nearest(segments[1], one.columns, 2)))
						}
					default:
						root := segments[0]
						if containsText(contextKeys, root) && len(segments) == 1 {
							continue
						}
						suggestion := ""
						switch {
						case sourceExists(sources, root):
							suggestion = fmt.Sprintf("Captures are read as ${capture.%s}.", whole)
						case fileCaptures[root]:
							suggestion = fmt.Sprintf(
								"Captures are read as ${capture.%s}, and only in the case that captured %s. Capture it in case %s too.",
								whole, root, caseName)
						default:
							candidates := append([]string(nil), contextKeys...)
							candidates = append(candidates, "capture", "param", "var")
							if nearest := spelling.Nearest(root, candidates, 2); nearest != "" {
								suggestion = "Did you mean " + nearest
							}
						}
						found = append(found, diag.NewError("E301", file, position, fmt.Sprintf(
							"${%s} resolves to nothing. A path starts at capture, param, var or a context key.", whole)).
							Suggest(suggestion))
					}
				}
			}
		}

		// W301: a capture nothing reads is a step whose result nobody checked.
		for _, name := range sortedNames(sources) {
			source := sources[name]
			if read[name] {
				continue
			}
			if !strings.HasPrefix(source.pointer, fmt.Sprintf("/tests/%d/", caseIndex)) {
				continue
			}
			found = append(found, diag.NewWarning("W301", file,
				document.At(source.pointer+"/captureAs").Value, fmt.Sprintf(
					"Capture %s in case %s is never read by a later step, an assertion or a cleanup.", name, caseName)))
		}
	}

	// E304: a meta step promising an export no step of it captures.
	for metaIndex, meta := range entriesOf(suite, "metaSteps") {
		if meta == nil {
			continue
		}
		captured := []string{}
		for _, step := range entriesOf(meta, "steps") {
			if step == nil {
				continue
			}
			if name := walk.Text(step, "captureAs"); name != "" {
				captured = append(captured, name)
			}
		}
		exports, _ := walk.List(meta, "exports")
		for exportIndex, raw := range exports {
			name, _ := raw.(string)
			if name == "" || containsText(captured, name) {
				continue
			}
			finding := diag.NewError("E304", file,
				document.At(fmt.Sprintf("/metaSteps/%d/exports/%d", metaIndex, exportIndex)).Value,
				fmt.Sprintf("Meta step %s exports %s, which none of its steps captures.",
					walk.Text(meta, "name"), name))
			found = append(found, finding.Suggest(spelling.Nearest(name, captured, 2)))
		}
	}

	// E309: a vars value has to be the same on every run, because a conformance
	// run compares it. Only the determinism rule is checked on a var: its paths
	// resolve against parameters and other vars rather than a case's captures.
	type varBlock struct {
		pointer string
		block   *model.Map
	}
	blocks := []varBlock{}
	if held, ok := walk.AsMap(suite.Value("vars")); ok {
		blocks = append(blocks, varBlock{"/vars", held})
	}
	for index, held := range entriesOf(suite, "tests") {
		if held == nil {
			continue
		}
		if nested, ok := walk.AsMap(held.Value("vars")); ok {
			blocks = append(blocks, varBlock{fmt.Sprintf("/tests/%d/vars", index), nested})
		}
	}
	for _, block := range blocks {
		for _, name := range block.block.Keys() {
			pointer := block.pointer + "/" + model.Escape(name)
			for _, reference := range expr.References(block.block.Value(name), pointer) {
				reading := expr.Read(reference.Expression, true)
				if reading.Err == nil || reading.Err.Code != "E309" {
					continue
				}
				found = append(found, diag.NewError("E309", file, document.At(reference.Pointer).Value,
					fmt.Sprintf("${%s} cannot be used in vars: %s.", reference.Expression, reading.Err.Message)).
					Suggest("Pass the value in with --param, or capture it in a step where a changing value is fine."))
			}
		}
	}

	// W303: a declared parameter nothing reads.
	for index, param := range entriesOf(suite, "params") {
		if param == nil {
			continue
		}
		name := walk.Text(param, "name")
		if readParams[name] {
			continue
		}
		found = append(found, diag.NewWarning("W303", file,
			document.At(fmt.Sprintf("/params/%d/name", index)).Value,
			fmt.Sprintf("Parameter %s is declared and never read.", name)))
	}

	return found
}

func sourceExists(sources map[string]produced, name string) bool {
	_, found := sources[name]
	return found
}

// leadingName is the run of letters, digits and underscores a piece of a script
// starts with, which is the capture name that followed `capture.`.
func leadingName(piece string) string {
	var out strings.Builder
	for _, character := range piece {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || character == '_' {
			out.WriteRune(character)
			continue
		}
		break
	}
	return out.String()
}
