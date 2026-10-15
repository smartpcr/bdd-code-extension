package model

import (
	"encoding/json"
	"testing"
)

func load(t *testing.T, text string) *Document {
	t.Helper()
	document, err := Load(text)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	return document
}

func TestAMappingRecordsTheKeyAndTheValueApart(t *testing.T) {
	document := load(t, "suite: typos\ntests:\n  - name: a\n    timeout: 30\n")
	if value, _ := document.Get("/suite"); value != "typos" {
		t.Errorf("suite %v", value)
	}
	suite := document.At("/suite")
	if suite.Key != (Position{1, 1}) || suite.Value != (Position{1, 8}) {
		t.Errorf("suite at %+v", suite)
	}
	timeout := document.At("/tests/0/timeout")
	if timeout.Key != (Position{4, 5}) || timeout.Value != (Position{4, 14}) {
		t.Errorf("timeout at %+v", timeout)
	}
}

func TestASequenceItemIsAtItsOwnEntry(t *testing.T) {
	document := load(t, "tests:\n  - name: a\n  - name: b\n")
	if got := document.At("/tests/0").Value; got != (Position{2, 5}) {
		t.Errorf("item 0 at %+v", got)
	}
	if got := document.At("/tests/1").Value; got != (Position{3, 5}) {
		t.Errorf("item 1 at %+v", got)
	}
}

func TestAnEmptySequenceEntryIsAtItsDash(t *testing.T) {
	document := load(t, "tests:\n  -\n  - name: b\n")
	if got := document.At("/tests/0").Value; got != (Position{2, 4}) {
		t.Errorf("the empty entry is at %+v, wanted 2:4", got)
	}
}

func TestScalarsResolveToTheTypesTheSchemaChecks(t *testing.T) {
	document := load(t, "a: 30\nb: '30'\nc: 1.5\nd: true\ne: false\nf: null\ng: ~\nh:\ni: text\nj: \"true\"\n")
	for _, row := range []struct {
		pointer string
		want    any
	}{
		{"/a", int64(30)},
		{"/b", "30"},
		{"/c", 1.5},
		{"/d", true},
		{"/e", false},
		{"/f", nil},
		{"/g", nil},
		{"/h", nil},
		{"/i", "text"},
		{"/j", "true"},
	} {
		got, _ := document.Get(row.pointer)
		if got != row.want {
			t.Errorf("%s is %v (%T), wanted %v (%T)", row.pointer, got, got, row.want, row.want)
		}
	}
}

func TestAFlowMappingIsReadLikeABlockOne(t *testing.T) {
	document := load(t, "params:\n  - { name: region, default: west }\n")
	if value, _ := document.Get("/params/0/name"); value != "region" {
		t.Errorf("name %v", value)
	}
	if got := document.At("/params/0/name").Key; got != (Position{2, 7}) {
		t.Errorf("the key is at %+v", got)
	}
	if got := document.At("/params/0").Value; got != (Position{2, 5}) {
		t.Errorf("the flow mapping starts at %+v, wanted its brace", got)
	}
}

func TestAFileThatIsNotYamlSaysSoAtTheStart(t *testing.T) {
	_, err := Load("suite: [unclosed\ntests: 1")
	failure, ok := err.(*LoadError)
	if !ok {
		t.Fatalf("wanted a LoadError, got %T", err)
	}
	if failure.Position != Start() {
		t.Errorf("at %+v, wanted the start of the file", failure.Position)
	}
	if failure.Error() == "" {
		t.Error("it said nothing about why")
	}
}

func TestAnEmptyFileHoldsNoDocument(t *testing.T) {
	if _, err := Load(""); err == nil {
		t.Error("an empty file was read as a suite")
	}
	if _, err := Load("# only a comment\n"); err == nil {
		t.Error("a comment was read as a suite")
	}
}

func TestADocumentThatIsAListStillParses(t *testing.T) {
	document := load(t, "- just\n- a\n- list\n")
	if _, ok := document.Value.([]any); !ok {
		t.Errorf("value is %T", document.Value)
	}
}

func TestPointersEscapeAndWalk(t *testing.T) {
	if Escape("a/b") != "a~1b" || Escape("a~b") != "a~0b" {
		t.Error("escaping")
	}
	if Child("/x", "a/b") != "/x/a~1b" {
		t.Error("child")
	}
	document := load(t, "tests:\n  - steps:\n      - action: core.noop\n")
	if value, _ := document.Get("/tests/0/steps/0/action"); value != "core.noop" {
		t.Errorf("action %v", value)
	}
	if _, ok := document.Get("/tests/9"); ok {
		t.Error("a pointer past the end resolved")
	}
	if _, ok := document.Get("/tests/0/steps/0/action/deeper"); ok {
		t.Error("a pointer into a scalar resolved")
	}
	if _, ok := Pointer(document.Value, ""); !ok {
		t.Error("the empty pointer is the document")
	}
}

func TestAnOrderedMapKeepsItsOrder(t *testing.T) {
	ordered := NewMap()
	for _, key := range []string{"b", "a", "c"} {
		ordered.Set(key, key)
	}
	ordered.Set("b", "again")
	if got := ordered.Keys(); len(got) != 3 || got[0] != "b" || got[2] != "c" {
		t.Errorf("keys %v", got)
	}
	if value, _ := ordered.Get("b"); value != "again" {
		t.Errorf("b is %v", value)
	}
	if ordered.Len() != 3 || !ordered.Has("a") || ordered.Has("z") {
		t.Error("len or has")
	}
	text, err := json.Marshal(ordered)
	if err != nil {
		t.Fatal(err)
	}
	if string(text) != `{"b":"again","a":"a","c":"c"}` {
		t.Errorf("json %s", text)
	}
}

func TestAnOrderedMapDeletesAndClones(t *testing.T) {
	ordered := NewMap()
	ordered.Set("a", 1)
	ordered.Set("b", 2)
	copied := ordered.Clone()
	ordered.Delete("a")
	ordered.Delete("nosuch")
	if ordered.Len() != 1 || ordered.Has("a") {
		t.Errorf("after delete %v", ordered.Keys())
	}
	if copied.Len() != 2 {
		t.Error("the copy changed with the original")
	}
	var empty *Map
	if empty.Len() != 0 || empty.Has("a") || empty.Keys() != nil || empty.Clone().Len() != 0 {
		t.Error("nothing behaves like an empty map")
	}
	empty.Delete("a")
	text, _ := json.Marshal(empty)
	if string(text) != "null" {
		t.Errorf("nothing serialises to %s", text)
	}
}

func TestAPositionIsOneBased(t *testing.T) {
	if NewPosition(0, 0) != (Position{1, 1}) {
		t.Error("zero clamps to one")
	}
	if NewPosition(4, 7) != (Position{4, 7}) {
		t.Error("a real position is kept")
	}
}
