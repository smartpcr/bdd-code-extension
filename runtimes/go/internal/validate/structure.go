// E100 to E105: the file parses, its keys are spelled and typed the way the
// schema says, and every step's parameters belong to its action.
//
// Two passes, for the reason DEC-Y05 gives. The first checks the whole document
// against the generated schema with the step union swapped for the envelope,
// because a validator that reports every unselected branch of a union reports
// four problems where there is one. The second checks each step against the one
// branch its action selects, so an unknown parameter is E105 and names the
// action rather than being one of four "no branch matched" messages.
package validate

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
	"golang.org/x/text/language"
	"golang.org/x/text/message"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/spelling"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/diag"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/schema"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

type failureKind int

const (
	// requiredKey is a key the object has to carry and does not.
	requiredKey failureKind = iota
	// unexpectedKey is a key nothing declares, at the pointer of the key itself.
	unexpectedKey
	// refusedValue is anything else: a wrong type, a value outside its range, a
	// string that does not match. One message, at the value.
	refusedValue
)

// schemaFailure is one thing the schema refused, at the pointer it refused it.
type schemaFailure struct {
	pointer string
	kind    failureKind
	name    string
	message string
}

// pointerName is a pointer as something a suite author recognises.
func pointerName(pointer string) string {
	if pointer == "" {
		return "the suite"
	}
	return "the suite at " + pointer
}

func keysOf(definition any) []string {
	held, ok := definition.(map[string]any)
	if !ok {
		return nil
	}
	names := make([]string, 0, len(held))
	for name := range held {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// legalKeys says what kind of place a pointer names, and which keys are legal
// there.
//
// Read out of the schema and the catalog rather than listed here, so a key
// added to either is offered without this function changing.
func legalKeys(pointer string, loaded *schema.Schema, step *walk.StepEntry) (string, []string) {
	if step != nil {
		action := walk.Text(step.Step, "action")
		if declared, found := loaded.Actions[action]; found {
			keys := append([]string(nil), loaded.StepCommonKeys...)
			keys = append(keys, declared.Params...)
			return action, keys
		}
		return "", propertiesOf(loaded.Defs["step.meta"])
	}

	var definition any
	switch {
	case pointer == "":
		definition = loaded.Document
	case pointer == "/defaults":
		definition = loaded.Defs["defaults"]
	case isShaped(pointer, "tests", "#"):
		definition = loaded.Defs["case"]
	case isShaped(pointer, "tests", "#", "asserts", "#"):
		definition = loaded.Defs["assert"]
	case isShaped(pointer, "metaSteps", "#"):
		definition = loaded.Defs["metaStep"]
	case isShaped(pointer, "metaSteps", "#", "params", "#"):
		definition = loaded.Defs["metaParamDecl"]
	case endsWithDigit(pointer) && strings.Contains(pointer, "params/"):
		definition = loaded.Defs["paramDecl"]
	}
	return "", propertiesOf(definition)
}

func propertiesOf(definition any) []string {
	held, ok := definition.(map[string]any)
	if !ok {
		return nil
	}
	return keysOf(held["properties"])
}

func endsWithDigit(pointer string) bool {
	if pointer == "" {
		return false
	}
	last := pointer[len(pointer)-1]
	return last >= '0' && last <= '9'
}

// isShaped says whether a pointer has a given shape, with # standing for any
// index.
func isShaped(pointer string, shape ...string) bool {
	if pointer == "" {
		return false
	}
	segments := strings.Split(pointer, "/")[1:]
	if len(segments) != len(shape) {
		return false
	}
	for index, expected := range shape {
		segment := segments[index]
		if expected == "#" {
			if segment == "" {
				return false
			}
			if _, err := strconv.Atoi(segment); err != nil {
				return false
			}
			continue
		}
		if segment != expected {
			return false
		}
	}
	return true
}

// compile turns a schema document into a validator.
//
// The document is written out and read back through the library's own reader,
// which keeps numbers as they were written. Handing it a map decoded by
// encoding/json would turn every integer into a float, and a schema that says
// minimum: 1 would then be comparing against 1.0.
func compile(document map[string]any) (*jsonschema.Schema, error) {
	text, err := json.Marshal(document)
	if err != nil {
		return nil, fmt.Errorf("the schema cannot be written out: %w", err)
	}
	read, err := jsonschema.UnmarshalJSON(bytes.NewReader(text))
	if err != nil {
		return nil, fmt.Errorf("the schema cannot be read back: %w", err)
	}
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource("suite.json", read); err != nil {
		return nil, fmt.Errorf("the schema cannot be compiled: %w", err)
	}
	compiled, err := compiler.Compile("suite.json")
	if err != nil {
		return nil, fmt.Errorf("the schema cannot be compiled: %w", err)
	}
	return compiled, nil
}

// failures is everything one schema refused about one document.
func failures(document map[string]any, instance any) ([]schemaFailure, error) {
	compiled, err := compile(document)
	if err != nil {
		return nil, err
	}
	refused := compiled.Validate(model.Plain(instance))
	if refused == nil {
		return nil, nil
	}
	reported, ok := refused.(*jsonschema.ValidationError)
	if !ok {
		return nil, fmt.Errorf("the schema refused the file: %w", refused)
	}
	found := []schemaFailure{}
	collect(reported, &found)
	return found, nil
}

// collect flattens the validator's tree of causes into the leaves that name a
// real problem. A container node - allOf, anyOf, the root - says only that
// something underneath failed, and reporting it as well would double every
// finding.
func collect(reported *jsonschema.ValidationError, found *[]schemaFailure) {
	if len(reported.Causes) > 0 {
		for _, cause := range reported.Causes {
			collect(cause, found)
		}
		return
	}
	pointer := instancePointer(reported.InstanceLocation)
	switch held := reported.ErrorKind.(type) {
	case *kind.Required:
		missing := append([]string(nil), held.Missing...)
		sort.Strings(missing)
		for _, name := range missing {
			*found = append(*found, schemaFailure{pointer: pointer, kind: requiredKey, name: name})
		}
	case *kind.AdditionalProperties:
		// The validator walks a Go map to find these, so the order it reports
		// them in is the order Go felt like. Sorted here, because two runs of
		// one binding must not disagree either.
		names := append([]string(nil), held.Properties...)
		sort.Strings(names)
		for _, name := range names {
			*found = append(*found, schemaFailure{
				pointer: pointer + "/" + model.Escape(name),
				kind:    unexpectedKey,
				name:    name,
			})
		}
	case *kind.FalseSchema:
		name := ""
		if at := strings.LastIndex(pointer, "/"); at >= 0 {
			name = pointer[at+1:]
		}
		*found = append(*found, schemaFailure{pointer: pointer, kind: unexpectedKey, name: name})
	default:
		// The kind's own words, without the "at '<pointer>'" the validator puts
		// in front. The diagnostic states the place already, and the pointer the
		// validator saw differs between the document pass and the step pass, so
		// with it one refusal read as two findings.
		*found = append(*found, schemaFailure{
			pointer: pointer,
			kind:    refusedValue,
			message: oneLine(reported.ErrorKind.LocalizedString(printer)),
		})
	}
}

// printer is the one the validator itself formats with.
var printer = message.NewPrinter(language.English)

// oneLine flattens what the validator wrote, because a diagnostic is one line
// and the validator indents a nested explanation over several.
func oneLine(message string) string {
	return strings.Join(strings.Fields(message), " ")
}

func instancePointer(location []string) string {
	if len(location) == 0 {
		return ""
	}
	var out strings.Builder
	for _, segment := range location {
		out.WriteByte('/')
		out.WriteString(model.Escape(segment))
	}
	return out.String()
}

func toDiagnostic(
	failure schemaFailure,
	document *model.Document,
	file string,
	loaded *schema.Schema,
	step *walk.StepEntry,
) diag.Diagnostic {
	switch failure.kind {
	case requiredKey:
		return diag.NewError("E102", file, document.At(failure.pointer).Key,
			fmt.Sprintf("Required key %s is missing from %s.", failure.name, pointerName(failure.pointer)))
	case unexpectedKey:
		parent := ""
		if at := strings.LastIndex(failure.pointer, "/"); at >= 0 {
			parent = failure.pointer[:at]
		}
		action, legal := legalKeys(parent, loaded, step)
		suggestion := spelling.Nearest(failure.name, legal, 2)
		position := document.At(failure.pointer).Key
		var finding diag.Diagnostic
		if action != "" {
			finding = diag.NewError("E105", file, position,
				fmt.Sprintf("Action %s takes no parameter %s.", action, failure.name))
		} else {
			finding = diag.NewError("E101", file, position,
				fmt.Sprintf("Unknown key %s in %s.", failure.name, pointerName(parent)))
		}
		if suggestion != "" {
			finding = finding.Suggest("Did you mean " + suggestion)
		}
		return finding
	default:
		return diag.NewError("E103", file, document.At(failure.pointer).Value,
			fmt.Sprintf("%s has a value the schema refuses: %s.", pointerName(failure.pointer), failure.message))
	}
}

// checkStructure is the structural pass.
func checkStructure(document *model.Document, file string, loaded *schema.Schema) ([]diag.Diagnostic, error) {
	found := []diag.Diagnostic{}
	suite, _ := document.Value.(*model.Map)

	refused, err := failures(loaded.Document, document.Value)
	if err != nil {
		return nil, err
	}
	for _, failure := range refused {
		found = append(found, toDiagnostic(failure, document, file, loaded, nil))
	}

	// One branch per step, selected by its action name.
	entries := walk.AllSteps(suite)
	branches := []any{}
	documents := []any{}
	checked := []walk.StepEntry{}
	for _, entry := range entries {
		action := walk.Text(entry.Step, "action")
		switch {
		case action != "":
			if !loaded.Has(action) {
				suggestion := spelling.Nearest(action, loaded.ActionNames, 3)
				finding := diag.NewError("E104", file,
					document.At(entry.Pointer+"/action").Value,
					fmt.Sprintf("Unknown action %s.", action))
				if suggestion != "" {
					finding = finding.Suggest("Did you mean " + suggestion)
				} else {
					finding = finding.Suggest("No action of that name is declared in actions.catalog.yaml.")
				}
				found = append(found, finding)
				continue
			}
			branches = append(branches, map[string]any{"$ref": "#/$defs/step." + action})
		case entry.Step.Value("meta") != nil:
			branches = append(branches, map[string]any{"$ref": "#/$defs/step.meta"})
		default:
			found = append(found, diag.NewError("E102", file, document.At(entry.Pointer).Key,
				"A step declares no action and no meta. One of the two is required."))
			continue
		}
		documents = append(documents, entry.Step)
		checked = append(checked, entry)
	}
	// A step list entry that is not a mapping at all never reaches the branch
	// check, because there is no action to select a branch by.
	found = append(found, notMappings(document, file, suite)...)

	if len(checked) > 0 {
		stepSchema := map[string]any{
			"$schema":    "https://json-schema.org/draft/2020-12/schema",
			"type":       "object",
			"properties": map[string]any{"steps": map[string]any{"type": "array", "prefixItems": branches}},
			"$defs":      loaded.Defs,
		}
		instance := map[string]any{"steps": documents}
		refused, err := failures(stepSchema, instance)
		if err != nil {
			return nil, err
		}
		for _, failure := range refused {
			rest := strings.TrimPrefix(failure.pointer, "/steps/")
			if rest == failure.pointer {
				continue
			}
			head, tail := rest, ""
			if at := strings.Index(rest, "/"); at >= 0 {
				head, tail = rest[:at], rest[at:]
			}
			index, err := strconv.Atoi(head)
			if err != nil || index < 0 || index >= len(checked) {
				continue
			}
			entry := checked[index]
			real := failure
			real.pointer = entry.Pointer + tail
			found = append(found, toDiagnostic(real, document, file, loaded, &entry))
		}
	}

	return found, nil
}

// notMappings is E103 for every entry of a step list that is not a mapping.
func notMappings(document *model.Document, file string, suite *model.Map) []diag.Diagnostic {
	found := []diag.Diagnostic{}
	for _, list := range walk.StepLists(suite) {
		for index, raw := range list.Steps {
			if raw == nil {
				// A blank entry is a hole in the list, not a broken step. The
				// schema refuses it where it matters and the walk skips it.
				continue
			}
			if _, ok := raw.(*model.Map); ok {
				continue
			}
			found = append(found, diag.NewError("E103", file,
				document.At(fmt.Sprintf("%s/%d", list.Pointer, index)).Value,
				"A step must be a mapping with an action."))
		}
	}
	return found
}

// Unparseable is the one finding a file that will not parse produces.
func Unparseable(file, message string, position model.Position) diag.Diagnostic {
	return diag.NewError("E100", file, position, "The file is not valid YAML: "+message)
}

// NotAMapping is the one finding a file that parses but is not a suite
// produces.
func NotAMapping(file string) diag.Diagnostic {
	return diag.NewError("E100", file, model.Start(),
		"The file does not hold a YAML mapping, so it cannot be a suite.")
}
