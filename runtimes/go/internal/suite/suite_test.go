package suite

import (
	"reflect"
	"strings"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

func parse(t *testing.T, text string) *model.Map {
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

func definitions(t *testing.T) map[string]*model.Map {
	t.Helper()
	held := parse(t, `
metaSteps:
  - name: mark
    params:
      - { name: label, default: unnamed }
    steps:
      - given: the marker of ${param.label}
        action: core.record
        marker: ${param.label}-one
      - given: the second of ${param.label}
        action: core.record
        marker: ${param.label}-two
        captureAs: second
`)
	return MetaDefinitions(held, newLibrary())
}

func stepsOf(t *testing.T, text string) []any {
	t.Helper()
	held := parse(t, text)
	steps, _ := walk.List(held, "steps")
	return steps
}

func TestAMetaStepBecomesTheStepsItStandsFor(t *testing.T) {
	steps := stepsOf(t, "steps:\n  - meta: mark\n    with: { label: chosen }\n")
	expanded, err := ExpandSteps(steps, definitions(t), "case c", 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(expanded) != 2 {
		t.Fatalf("%d steps", len(expanded))
	}
	if Text(expanded[0], "marker") != "chosen-one" || Text(expanded[1], "marker") != "chosen-two" {
		t.Errorf("the markers are %v and %v", Text(expanded[0], "marker"), Text(expanded[1], "marker"))
	}
	if Text(expanded[0], "__provenance") != "meta mark step 1" {
		t.Errorf("the provenance is %q", Text(expanded[0], "__provenance"))
	}
	if Text(expanded[0], "__keyword") != "given" {
		t.Errorf("the keyword is %q", Text(expanded[0], "__keyword"))
	}
	if !strings.HasPrefix(StepLabel(expanded[0]), "given the marker of chosen (core.record)") {
		t.Errorf("the label is %q", StepLabel(expanded[0]))
	}
}

func TestADefaultIsUsedWhenTheUseSitePassesNothing(t *testing.T) {
	expanded, err := ExpandSteps(stepsOf(t, "steps:\n  - meta: mark\n"), definitions(t), "case c", 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if Text(expanded[0], "marker") != "unnamed-one" {
		t.Errorf("the marker is %q", Text(expanded[0], "marker"))
	}
}

func TestAGuardOnAUseSiteReachesEveryStepItStandsFor(t *testing.T) {
	expanded, err := ExpandSteps(
		stepsOf(t, "steps:\n  - meta: mark\n    ifCapture: held\n"), definitions(t), "case c", 0, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range expanded {
		if Text(step, "ifCapture") != "held" {
			t.Errorf("a step of the group carries %q", Text(step, "ifCapture"))
		}
	}
}

func TestAMetaStepNobodyDeclaredIsRefusedByName(t *testing.T) {
	_, err := ExpandSteps(stepsOf(t, "steps:\n  - meta: nosuch\n"), definitions(t), "case c", 0, "")
	if err == nil {
		t.Fatal("a meta step nobody declared expanded")
	}
	if !strings.Contains(err.Error(), "nosuch") || !strings.Contains(err.Error(), "case c step 1") {
		t.Errorf("it said %q", err)
	}
}

func TestANestPastTheLimitIsRefusedRatherThanRecursedInto(t *testing.T) {
	held := parse(t, "metaSteps:\n  - name: a\n    steps:\n      - meta: a\n")
	_, err := ExpandSteps(stepsOf(t, "steps:\n  - meta: a\n"),
		MetaDefinitions(held, newLibrary()), "case c", 0, "")
	if err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Errorf("it said %v", err)
	}
}

func TestATableBecomesOneStepPerRowInRowOrder(t *testing.T) {
	steps := stepsOf(t, `
steps:
  - when: each node is recorded
    action: core.record
    marker: ${row.node}
    table:
      - { node: N1 }
      - { node: N2 }
`)
	expanded, err := ExpandSteps(steps, definitions(t), "case c", 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(expanded) != 2 {
		t.Fatalf("%d steps", len(expanded))
	}
	if expanded[0].Value("__rowIndex") != int64(1) || expanded[1].Value("__rowIndex") != int64(2) {
		t.Error("the row indexes")
	}
	if expanded[0].Value("__rowCount") != int64(2) {
		t.Error("the row count")
	}
	if expanded[0].Has("table") {
		t.Error("the expanded step kept its table")
	}
	if !strings.Contains(StepLabel(expanded[1]), "row 2 (node=N2)") {
		t.Errorf("the label is %q", StepLabel(expanded[1]))
	}
}

func TestAnAndContinuesTheKeywordBeforeItAndOnlyInsideItsOwnList(t *testing.T) {
	steps := stepsOf(t, `
steps:
  - given: a host
    action: core.noop
  - and: another thing
    action: core.noop
  - when: it moves
    action: core.noop
  - and: it settles
    action: core.noop
`)
	expanded, err := ExpandSteps(steps, definitions(t), "case c", 0, "")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"given", "given", "when", "when"}
	for index, keyword := range want {
		if got := Text(expanded[index], "__keyword"); got != keyword {
			t.Errorf("step %d is %q, wanted %q", index+1, got, keyword)
		}
	}
	// The sentence stays the step's own.
	if Text(expanded[1], "__sentence") != "another thing" {
		t.Errorf("the sentence is %q", Text(expanded[1], "__sentence"))
	}
	// An and with nothing before it in its own list keeps the word itself.
	lonely, err := ExpandSteps(stepsOf(t, "steps:\n  - and: alone\n    action: core.noop\n"),
		definitions(t), "case c", 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if Text(lonely[0], "__keyword") != "and" {
		t.Errorf("a lone and is %q", Text(lonely[0], "__keyword"))
	}
}

func TestAnOutlineBecomesOneCasePerRowNamedByIt(t *testing.T) {
	held := parse(t, "name: c\nexamples:\n  - { node: N1 }\n  - { node: N2 }\nsteps: []\n")
	expanded := ExpandOutline(held)
	if len(expanded) != 2 {
		t.Fatalf("%d cases", len(expanded))
	}
	if Text(expanded[0], "name") != "c [node=N1]" {
		t.Errorf("the first is %q", Text(expanded[0], "name"))
	}
	row, _ := walk.AsMap(expanded[1].Value("__row"))
	if row.Value("node") != "N2" {
		t.Errorf("the second row is %v", row)
	}
	if expanded[0].Has("examples") {
		t.Error("the expanded case kept its examples")
	}
	plain := parse(t, "name: c\n")
	if len(ExpandOutline(plain)) != 1 {
		t.Error("a case with no examples became more than one")
	}
	empty := parse(t, "name: c\nexamples: []\n")
	if len(ExpandOutline(empty)) != 1 {
		t.Error("an empty examples block became no cases")
	}
}

func TestAParameterTakesTheValueOfTheHighestLevelThatNamesIt(t *testing.T) {
	library := newLibrary()
	library.Params = entries(parse(t, "params:\n  - { name: shared, default: library }\n"), "params")
	suite := parse(t, "params:\n  - { name: shared, default: file }\n  - { name: fromFile, default: file }\n")
	held := parse(t, "params:\n  - { name: shared, value: case }\n")
	values := ResolveParams(library, suite, held, [][2]string{{"fromFile", "command line"}}, "BDD_SUITE_")
	if values.Value("shared") != "case" {
		t.Errorf("shared is %v", values.Value("shared"))
	}
	if values.Value("fromFile") != "command line" {
		t.Errorf("fromFile is %v", values.Value("fromFile"))
	}
}

func TestAnEnvironmentVariableBeatsTheFileAndLosesToTheCommandLine(t *testing.T) {
	t.Setenv("BDD_SUITE_PARAM_SITE", "from the environment")
	t.Setenv("ACME_PARAM_SITE", "from the extension's prefix")
	suite := parse(t, "params:\n  - { name: site, default: from the file }\n")
	values := ResolveParams(newLibrary(), suite, nil, nil, "BDD_SUITE_")
	if values.Value("site") != "from the environment" {
		t.Errorf("site is %v", values.Value("site"))
	}
	// The prefix is the composite's: an extension that sets ACME_ is read as ACME_PARAM_.
	values = ResolveParams(newLibrary(), suite, nil, nil, "ACME_")
	if values.Value("site") != "from the extension's prefix" {
		t.Errorf("with the prefix ACME_ site is %v", values.Value("site"))
	}
	values = ResolveParams(newLibrary(), suite, nil, [][2]string{{"site", "from the command line"}}, "BDD_SUITE_")
	if values.Value("site") != "from the command line" {
		t.Errorf("site is %v", values.Value("site"))
	}
}

func TestVariablesAreEvaluatedAgainstWhatIsAlreadyInScope(t *testing.T) {
	suite := parse(t, "vars:\n  region: west\n  greeting: hello ${var.region}\n")
	scope := model.NewMap()
	scope.Set("var", model.NewMap())
	if err := ResolveVars(newLibrary(), suite, nil, scope); err != nil {
		t.Fatal(err)
	}
	bag, _ := walk.AsMap(scope.Value("var"))
	if bag.Value("greeting") != "hello west" {
		t.Errorf("greeting is %v", bag.Value("greeting"))
	}
	// A case's own variables come last, so they see the suite's.
	held := parse(t, "vars:\n  full: ${var.greeting} again\n")
	if err := ResolveVars(newLibrary(), suite, held, scope); err != nil {
		t.Fatal(err)
	}
	bag, _ = walk.AsMap(scope.Value("var"))
	if bag.Value("full") != "hello west again" {
		t.Errorf("full is %v", bag.Value("full"))
	}
	broken := parse(t, "vars:\n  bad: ${nosuch.thing}\n")
	if err := ResolveVars(newLibrary(), broken, nil, scope); err == nil {
		t.Error("a variable naming nothing resolved")
	}
}

func TestALimitMayShortenAndNeverLengthen(t *testing.T) {
	if StepLimit(0, 120) != 120 {
		t.Error("no limit of its own")
	}
	if StepLimit(30, 120) != 30 {
		t.Error("a shorter limit")
	}
	if StepLimit(300, 120) != 120 {
		t.Error("a longer limit")
	}
}

func TestATagFilterSelectsByAnyMatch(t *testing.T) {
	if !TagsMatch([]string{"a"}, nil) {
		t.Error("no filter selects everything")
	}
	if !TagsMatch([]string{"a", "b"}, []string{"b"}) {
		t.Error("one match selects")
	}
	if TagsMatch([]string{"a"}, []string{"b"}) {
		t.Error("no match selects")
	}
	suite := parse(t, "tags: [suite]\n")
	held := parse(t, "tags: [own]\n")
	if got := CaseTags(suite, held); !reflect.DeepEqual(got, []string{"own", "suite"}) {
		t.Errorf("the tags are %v", got)
	}
}

func TestAStepWithNoSentenceIsNamedForItsAction(t *testing.T) {
	plain := parse(t, "action: core.noop\n")
	if StepLabel(plain) != "step core.noop" {
		t.Errorf("the label is %q", StepLabel(plain))
	}
	provenance := parse(t, "action: core.noop\n__provenance: step 1\n")
	if StepLabel(provenance) != "step 1 (core.noop)" {
		t.Errorf("the label is %q", StepLabel(provenance))
	}
	if FormatRow(nil) != "" {
		t.Error("nothing formats as a row")
	}
}

func TestAnImportThatIsNotThereOrFormsACycleIsRefused(t *testing.T) {
	held := parse(t, "imports: [nosuchfile.yml]\n")
	if _, err := ReadLibraries(held, "suite.yml"); err == nil {
		t.Error("an import that is not there was read")
	}
	if _, err := ReadLibraries(parse(t, "imports: [suite.yml]\n"), "suite.yml"); err == nil {
		t.Error("a file importing itself was read")
	}
}

func TestEveryStepListOfASuiteAndOfACaseIsExpanded(t *testing.T) {
	suite := parse(t, `
setup:
  - action: core.noop
teardown:
  - meta: mark
tests:
  - name: c
    steps:
      - action: core.noop
`)
	hooks, err := ExpandedHooks(suite, definitions(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(hooks["setup"]) != 1 || len(hooks["teardown"]) != 2 {
		t.Errorf("the hooks are %v", hooks)
	}
	if len(hooks["beforeEach"]) != 0 {
		t.Error("a hook nobody declared has steps")
	}
	cases := Cases(suite)
	if len(cases) != 1 {
		t.Fatalf("%d cases", len(cases))
	}
	phases, err := ExpandedCase(cases[0], definitions(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(phases["steps"]) != 1 || len(phases["cleanup"]) != 0 {
		t.Errorf("the phases are %v", phases)
	}
}
