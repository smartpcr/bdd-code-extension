// Package walk says where the steps are.
//
// Two views of the same file, because two passes need different ones. The
// structural pass wants every step once, flattened, with its pointer. The
// Gherkin rules are per list - a case's steps are one scenario and its cleanup
// is not part of it - so that pass wants the lists.
package walk

import (
	"fmt"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
)

// StepEntry is one step, with where it is written and when it runs.
type StepEntry struct {
	Step    *model.Map
	Pointer string
	Phase   string
	// Order counts ten per step, so a nested step can sit just before the one
	// that drives it. The dataflow pass compares these to decide whether a
	// capture exists yet.
	Order int64
}

// StepList is one list of steps, with what to call it in a message.
type StepList struct {
	Steps     []any
	Pointer   string
	Name      string
	Case      *model.Map
	CaseIndex int
}

// Hooks is the four suite-level step lists, in the order they run.
var Hooks = []string{"setup", "beforeEach", "afterEach", "teardown"}

// CasePhases is the three step lists one case owns.
var CasePhases = []string{"setup", "steps", "cleanup"}

// List reads one key of a map as a list of anything.
func List(held *model.Map, key string) ([]any, bool) {
	if held == nil {
		return nil, false
	}
	found, present := held.Get(key)
	if !present {
		return nil, false
	}
	items, ok := found.([]any)
	return items, ok
}

// Text reads one key of a map as text.
func Text(held *model.Map, key string) string {
	if held == nil {
		return ""
	}
	if found, ok := held.Value(key).(string); ok {
		return found
	}
	return ""
}

// AsMap reads a value as an object.
func AsMap(value any) (*model.Map, bool) {
	held, ok := value.(*model.Map)
	return held, ok && held != nil
}

// StepEntries flattens one list into an entry per step, nested steps included.
func StepEntries(list []any, pointer, phase string) []StepEntry {
	entries := []StepEntry{}
	for index, raw := range list {
		step, ok := AsMap(raw)
		if !ok {
			continue
		}
		order := int64(index) * 10
		stepPointer := fmt.Sprintf("%s/%d", pointer, index)
		// A `wait` runs a nested step and publishes its capture just before
		// polling it, so the nested one is ordered one ahead of its parent.
		if nested, ok := AsMap(step.Value("forStep")); ok {
			entries = append(entries, StepEntry{
				Step:    nested,
				Pointer: stepPointer + "/forStep",
				Phase:   phase,
				Order:   order - 1,
			})
		}
		entries = append(entries, StepEntry{Step: step, Pointer: stepPointer, Phase: phase, Order: order})
	}
	return entries
}

// AllSteps is every step in the file, once.
func AllSteps(suite *model.Map) []StepEntry {
	entries := []StepEntry{}
	for _, hook := range Hooks {
		steps, _ := List(suite, hook)
		entries = append(entries, StepEntries(steps, "/"+hook, hook)...)
	}
	if metas, ok := List(suite, "metaSteps"); ok {
		for index, raw := range metas {
			meta, ok := AsMap(raw)
			if !ok {
				continue
			}
			steps, _ := List(meta, "steps")
			entries = append(entries, StepEntries(
				steps,
				fmt.Sprintf("/metaSteps/%d/steps", index),
				"meta "+Text(meta, "name"),
			)...)
		}
	}
	if cases, ok := List(suite, "tests"); ok {
		for index, raw := range cases {
			held, ok := AsMap(raw)
			if !ok {
				continue
			}
			for _, phase := range CasePhases {
				steps, _ := List(held, phase)
				entries = append(entries, StepEntries(steps, fmt.Sprintf("/tests/%d/%s", index, phase), phase)...)
			}
		}
	}
	return entries
}

// StepLists is every list of steps in the file, with a name a message can use.
func StepLists(suite *model.Map) []StepList {
	lists := []StepList{}
	push := func(steps []any, present bool, pointer, name string, held *model.Map, caseIndex int) {
		if !present {
			return
		}
		lists = append(lists, StepList{
			Steps:     steps,
			Pointer:   pointer,
			Name:      name,
			Case:      held,
			CaseIndex: caseIndex,
		})
	}
	for _, hook := range Hooks {
		steps, present := List(suite, hook)
		push(steps, present, "/"+hook, "the suite "+hook, nil, -1)
	}
	if metas, ok := List(suite, "metaSteps"); ok {
		for index, raw := range metas {
			meta, ok := AsMap(raw)
			if !ok {
				continue
			}
			steps, present := List(meta, "steps")
			push(steps, present, fmt.Sprintf("/metaSteps/%d/steps", index), "meta step "+Text(meta, "name"), nil, -1)
		}
	}
	if cases, ok := List(suite, "tests"); ok {
		for index, raw := range cases {
			held, ok := AsMap(raw)
			if !ok {
				continue
			}
			for _, phase := range CasePhases {
				steps, present := List(held, phase)
				push(
					steps,
					present,
					fmt.Sprintf("/tests/%d/%s", index, phase),
					fmt.Sprintf("case %s %s", Text(held, "name"), phase),
					held,
					index,
				)
			}
		}
	}
	return lists
}

// TableColumns is the columns a table declares, which is what its first row
// holds.
func TableColumns(table any) []string {
	rows, ok := table.([]any)
	if !ok {
		return nil
	}
	for _, row := range rows {
		if held, ok := AsMap(row); ok {
			return held.Keys()
		}
	}
	return nil
}
