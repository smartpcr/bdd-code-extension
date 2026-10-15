package walk

import (
	"reflect"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
)

func suite(t *testing.T, text string) *model.Map {
	t.Helper()
	document, err := model.Load(text)
	if err != nil {
		t.Fatal(err)
	}
	held, ok := document.Value.(*model.Map)
	if !ok {
		t.Fatal("the text does not hold a mapping")
	}
	return held
}

func TestEveryStepIsFoundOnceWithItsPointer(t *testing.T) {
	held := suite(t, "setup:\n  - action: core.noop\nmetaSteps:\n  - name: m\n    steps:\n      - action: core.set\ntests:\n  - name: c\n    setup:\n      - action: core.record\n    steps:\n      - action: core.fail\n    cleanup:\n      - action: core.sleep\n")
	pointers := []string{}
	for _, entry := range AllSteps(held) {
		pointers = append(pointers, entry.Pointer)
	}
	want := []string{
		"/setup/0", "/metaSteps/0/steps/0",
		"/tests/0/setup/0", "/tests/0/steps/0", "/tests/0/cleanup/0",
	}
	if !reflect.DeepEqual(pointers, want) {
		t.Errorf("the pointers are %v", pointers)
	}
}

func TestANestedStepRunsJustBeforeTheOneThatDrivesIt(t *testing.T) {
	held := suite(t, "tests:\n  - name: c\n    steps:\n      - action: wait\n        forStep:\n          action: core.noop\n")
	entries := AllSteps(held)
	if len(entries) != 2 {
		t.Fatalf("%d entries", len(entries))
	}
	if entries[0].Pointer != "/tests/0/steps/0/forStep" || entries[0].Order != -1 {
		t.Errorf("the nested step is %+v", entries[0])
	}
	if entries[1].Pointer != "/tests/0/steps/0" || entries[1].Order != 0 {
		t.Errorf("the driving step is %+v", entries[1])
	}
}

func TestABlankEntryInAListIsNotAStep(t *testing.T) {
	held := suite(t, "tests:\n  - name: c\n    steps:\n      - action: core.noop\n      -\n      - action: core.fail\n")
	entries := AllSteps(held)
	if len(entries) != 2 {
		t.Fatalf("%d entries", len(entries))
	}
	if entries[1].Pointer != "/tests/0/steps/2" {
		t.Errorf("the index did not keep its place: %s", entries[1].Pointer)
	}
}

func TestTheListsAreNamedForWhatAMessageNeeds(t *testing.T) {
	held := suite(t, "setup:\n  - action: core.noop\nmetaSteps:\n  - name: m\n    steps:\n      - action: core.set\ntests:\n  - name: c\n    steps:\n      - action: core.fail\n    cleanup:\n      - action: core.sleep\n")
	lists := StepLists(held)
	names := []string{}
	for _, list := range lists {
		names = append(names, list.Name)
	}
	want := []string{"the suite setup", "meta step m", "case c steps", "case c cleanup"}
	if !reflect.DeepEqual(names, want) {
		t.Errorf("the names are %v", names)
	}
	if lists[2].CaseIndex != 0 || lists[2].Case == nil {
		t.Error("a case list does not know which case it belongs to")
	}
	if lists[0].Case != nil || lists[0].CaseIndex != -1 {
		t.Error("a hook list claims a case")
	}
}

func TestATableDeclaresItsColumnsInItsFirstRow(t *testing.T) {
	held := suite(t, "tests:\n  - name: c\n    steps:\n      - action: core.noop\n        table:\n          - { node: N1, state: Up }\n          - { node: N2, state: Down }\n")
	steps, _ := List(held, "tests")
	first, _ := AsMap(steps[0])
	list, _ := List(first, "steps")
	step, _ := AsMap(list[0])
	if got := TableColumns(step.Value("table")); !reflect.DeepEqual(got, []string{"node", "state"}) {
		t.Errorf("the columns are %v", got)
	}
	if TableColumns(nil) != nil || TableColumns("x") != nil {
		t.Error("something that is not a table declares columns")
	}
}

func TestAFileWithNothingInItHasNoSteps(t *testing.T) {
	held := suite(t, "suite: empty\n")
	if len(AllSteps(held)) != 0 || len(StepLists(held)) != 0 {
		t.Error("an empty suite has steps")
	}
}
