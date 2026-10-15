package value

import (
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
)

func TestAValueReadsAsTheTextFourBindingsWrite(t *testing.T) {
	object := model.NewMap()
	object.Set("a", int64(1))
	for _, row := range []struct {
		held any
		want string
	}{
		{nil, ""},
		{true, "true"},
		{false, "false"},
		{"x", "x"},
		{int64(3), "3"},
		{3.0, "3"},
		{3.5, "3.5"},
		{int64(-2), "-2"},
		{[]any{"a", "b"}, "a, b"},
		{object, `{"a":1}`},
	} {
		if got := Text(row.held); got != row.want {
			t.Errorf("%v (%T) reads as %q, wanted %q", row.held, row.held, got, row.want)
		}
	}
}

func TestANumberComesOutOfTextWhenItIsOne(t *testing.T) {
	for _, row := range []struct {
		held  any
		want  float64
		isOne bool
	}{
		{int64(3), 3, true},
		{"3.5", 3.5, true},
		{" 4 ", 4, true},
		{"x", 0, false},
		{nil, 0, false},
		{true, 0, false},
	} {
		got, ok := AsNumber(row.held)
		if ok != row.isOne || (ok && got != row.want) {
			t.Errorf("%v reads as %v, %v", row.held, got, ok)
		}
	}
}

func TestTheSmallReadersOnAnObject(t *testing.T) {
	object := model.NewMap()
	object.Set("name", "n1")
	object.Set("nodes", []any{"a", "b"})
	object.Set("blank", nil)
	if TextOf(object, "name") != "n1" || TextOf(object, "nodes") != "" || TextOf("x", "name") != "" {
		t.Error("TextOf")
	}
	if len(ListOf(object, "nodes")) != 2 || ListOf(object, "name") != nil || ListOf(nil, "x") != nil {
		t.Error("ListOf")
	}
	if !Present(object, "name") || Present(object, "blank") || Present(object, "missing") {
		t.Error("Present")
	}
	if !IsList([]any{}) || IsList("x") {
		t.Error("IsList")
	}
	if held, ok := AsMap(object); !ok || held.Len() != 3 {
		t.Error("AsMap")
	}
}
