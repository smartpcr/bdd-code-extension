package expr

import (
	"os"
	"strings"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
)

// The corpus table in conformance/expressions is the specification and
// is enumerated by the conformance package. What is here is the rest: the paths
// a shared table cannot reach because they are about this language rather than
// about the expression grammar.

func scopeValue(t *testing.T) *model.Map {
	t.Helper()
	document, err := model.Load(`
capture:
  cs:
    State: Up
    Nodes: [N1, N2, N3]
param:
  site: lab1
var:
  deadline: 240
row:
  node: N2
region: eu-west
zone: Z1
timeoutSec: 300
defaults:
  zone: Z1
`)
	if err != nil {
		t.Fatal(err)
	}
	held, _ := document.Value.(*model.Map)
	return held
}

func TestARefusalCarriesItsCode(t *testing.T) {
	failure := refuse("E305", "it stopped")
	if failure.Error() != "E305: it stopped" {
		t.Errorf("a refusal reads %q", failure.Error())
	}
}

func TestAnExpressionComesApartIntoItsPieces(t *testing.T) {
	pieces, err := Tokenise("lower('A') + 1.5 == x.y")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(pieces, "|")
	for _, want := range []string{"lower", "A", "1.5", "==", "x", "y"} {
		if !strings.Contains(joined, want) {
			t.Errorf("%s is missing from %s", want, joined)
		}
	}
	if _, err := Tokenise("'unclosed"); err == nil {
		t.Error("an unclosed string came apart cleanly")
	}
}

func TestAPathReadsBothShapesAValueCanArriveIn(t *testing.T) {
	fromYaml := model.NewMap()
	fromYaml.Set("a", int64(1))
	if got, ok := Field(fromYaml, "a"); !ok || got != int64(1) {
		t.Error("an ordered map")
	}
	fromJSON := map[string]any{"a": int64(1)}
	if got, ok := Field(fromJSON, "a"); !ok || got != int64(1) {
		t.Error("a plain map")
	}
	if _, ok := Field("text", "a"); ok {
		t.Error("a string has a member")
	}
	if _, ok := Field(fromJSON, "missing"); ok {
		t.Error("a missing key resolved")
	}
}

func TestAListIsWhateverWasGivenTakenAsOne(t *testing.T) {
	if len(asList([]any{1, 2})) != 2 {
		t.Error("a list")
	}
	if len(asList(nil)) != 0 {
		t.Error("nothing is an empty list")
	}
	if len(asList("one")) != 1 {
		t.Error("a scalar is a list of one")
	}
}

func TestTheNonDeterministicFunctionsProduceSomethingWhenTheyAreAllowed(t *testing.T) {
	scope := NewScope(model.NewMap())
	identifier, err := Evaluate("uuid()", scope)
	if err != nil {
		t.Fatal(err)
	}
	held, _ := identifier.(string)
	if len(held) != 32 {
		t.Errorf("uuid produced %q", held)
	}
	second, _ := Evaluate("uuid()", scope)
	if second == identifier {
		t.Error("two identifiers are the same")
	}
	now, err := Evaluate("nowIso()", scope)
	if err != nil {
		t.Fatal(err)
	}
	stamp, _ := now.(string)
	if len(stamp) != 20 || !strings.HasSuffix(stamp, "Z") || stamp[4] != '-' {
		t.Errorf("nowIso produced %q", stamp)
	}
	t.Setenv("BDD_SUITE_EXPR_PROBE", "seen")
	if got, _ := Evaluate("env('BDD_SUITE_EXPR_PROBE')", scope); got != "seen" {
		t.Errorf("env produced %v", got)
	}
	if _, set := os.LookupEnv("BDD_SUITE_EXPR_NOTHING"); set {
		t.Skip("the machine already sets the name this checks the absence of")
	}
	if got, _ := Evaluate("env('BDD_SUITE_EXPR_NOTHING')", scope); got != "" {
		t.Errorf("an unset name produced %v", got)
	}
}

func TestAnExpressionThatEndsEarlyOrLateIsRefused(t *testing.T) {
	scope := NewScope(scopeValue(t))
	for _, text := range []string{"", "1 +", "(1", "lower(", "1 2", "1 ? 2", "x.", "@"} {
		if _, err := Evaluate(text, scope); err == nil {
			t.Errorf("%q was read as something", text)
		}
	}
}

func TestATemplateSubstitutesAndKeepsBeingAString(t *testing.T) {
	scope := NewScope(scopeValue(t), contextRoots...)
	got, err := Expand("the region is ${region}", scope)
	if err != nil {
		t.Fatal(err)
	}
	if got != "the region is eu-west" {
		t.Errorf("a template produced %v", got)
	}
	// A whole-string expression keeps its type; anything else is text.
	whole, err := Expand("${timeoutSec}", scope)
	if err != nil {
		t.Fatal(err)
	}
	if whole != int64(300) {
		t.Errorf("a whole-string expression produced %v (%T)", whole, whole)
	}
	// A brace with nothing closing it is text, not a refusal.
	loose, err := Expand("${unclosed", scope)
	if err != nil || loose != "${unclosed" {
		t.Errorf("an unclosed reference produced %v, %v", loose, err)
	}
	if _, err := Expand("a ${nosuch.thing} b", scope); err == nil {
		t.Error("a template naming nothing was substituted")
	}
}

func TestAValueIsWalkedWhereverAReferenceIsWritten(t *testing.T) {
	scope := NewScope(scopeValue(t), contextRoots...)
	nested := model.NewMap()
	nested.Set("name", "${region}")
	nested.Set("items", []any{"${zone}", int64(2)})
	expanded, err := Expand(nested, scope)
	if err != nil {
		t.Fatal(err)
	}
	held, _ := expanded.(*model.Map)
	if held.Value("name") != "eu-west" {
		t.Errorf("the nested name is %v", held.Value("name"))
	}
	items, _ := held.Value("items").([]any)
	if len(items) != 2 || items[0] != "Z1" || items[1] != int64(2) {
		t.Errorf("the nested list is %v", items)
	}
	if _, err := Expand(int64(4), scope); err != nil {
		t.Error("a number could not be expanded")
	}
	// A list or a map with a bad reference inside it reports rather than
	// silently keeping the text.
	broken := []any{"${nosuch.thing}"}
	if _, err := Expand(broken, scope); err == nil {
		t.Error("a list hid a bad reference")
	}
	inMap := model.NewMap()
	inMap.Set("x", "${nosuch.thing}")
	if _, err := Expand(inMap, scope); err == nil {
		t.Error("a map hid a bad reference")
	}
}

func TestEveryReferenceIsFoundWithThePointerItWasWrittenAt(t *testing.T) {
	held := model.NewMap()
	held.Set("action", "core.set")
	held.Set("value", "${param.site} and ${region}")
	held.Set("list", []any{"${zone}"})
	held.Set("number", int64(3))
	found := References(held, "/tests/0/steps/0")
	if len(found) != 3 {
		t.Fatalf("found %v", found)
	}
	if found[0].Pointer != "/tests/0/steps/0/value" || found[0].Expression != "param.site" {
		t.Errorf("the first is %+v", found[0])
	}
	if found[2].Pointer != "/tests/0/steps/0/list/0" {
		t.Errorf("the one in the list is at %s", found[2].Pointer)
	}
	if len(References("plain text", "/x")) != 0 {
		t.Error("plain text carries a reference")
	}
	if len(References("${unclosed", "/x")) != 0 {
		t.Error("an unclosed brace is a reference")
	}
}

func TestReadingSaysWhatAnExpressionNamesWithoutRunningIt(t *testing.T) {
	reading := Read("lower(capture.cs.State) == 'up' and param.site", false)
	if reading.Err != nil {
		t.Fatalf("it refused: %v", reading.Err)
	}
	if len(reading.Functions) != 1 || reading.Functions[0] != "lower" {
		t.Errorf("the functions are %v", reading.Functions)
	}
	if len(reading.Paths) != 2 {
		t.Errorf("the paths are %v", reading.Paths)
	}
	if strings.Join(reading.Paths[0], ".") != "capture.cs.State" {
		t.Errorf("the first path is %v", reading.Paths[0])
	}
	// The keywords are not paths.
	if Read("true and not false or null", false).Paths != nil {
		t.Error("a keyword was read as a path")
	}
	// An index in a path keeps its place.
	if got := Read("capture.cs.Nodes.1", false); strings.Join(got.Paths[0], ".") != "capture.cs.Nodes.1" {
		t.Errorf("an index reads as %v", got.Paths[0])
	}
	// A path that ends at a dot stops rather than running off the end.
	if refused := Read("capture.", false); refused.Err == nil {
		t.Error("a path ending in a dot parsed")
	}
	if refused := Read("'unclosed", false); refused.Err == nil {
		t.Error("an unclosed string parsed")
	}
	if refused := Read("uuid()", true); refused.Err == nil || refused.Err.Code != "E309" {
		t.Errorf("a stable reading of uuid gives %v", refused.Err)
	}
}

func TestTheParserStopsAtTheEndRatherThanPastIt(t *testing.T) {
	reader := &parser{tokens: nil, source: "", scope: NewScope(nil)}
	if reader.peek().kind != tokenEnd {
		t.Error("an empty token list does not end")
	}
	if reader.next().kind != tokenEnd {
		t.Error("reading past the end is not the end")
	}
}

func TestAFailureInsideAnExpressionReachesTheTopOfIt(t *testing.T) {
	scope := NewScope(scopeValue(t))
	// One per level of the parser, so a refusal raised deep in a nested
	// expression is the one reported rather than being swallowed on the way up.
	for _, text := range []string{
		"nosuch.thing ? 1 : 2",
		"true ? nosuch.thing : 2",
		"false ? 1 : nosuch.thing",
		"nosuch.thing or true",
		"false or nosuch.thing",
		"nosuch.thing and true",
		"true and nosuch.thing",
		"nosuch.thing == 1",
		"1 == nosuch.thing",
		"nosuch.thing + 1",
		"1 + nosuch.thing",
		"nosuch.thing - 1",
		"1 - nosuch.thing",
		"nosuch.thing * 2",
		"2 * nosuch.thing",
		"- nosuch.thing",
		"not nosuch.thing",
		"(nosuch.thing)",
		"lower(nosuch.thing)",
		"lower('a') + nosuch.thing",
	} {
		if _, err := Evaluate(text, scope); err == nil {
			t.Errorf("%q produced a value", text)
		}
	}
	// A value that is not true or false stops an and or an or rather than
	// being guessed at.
	for _, text := range []string{"'maybe' and true", "true and 'maybe'", "'maybe' or true", "false or 'maybe'", "not 'maybe'", "'maybe' ? 1 : 2"} {
		held, err := Evaluate(text, scope)
		if err == nil {
			t.Errorf("%q produced %v", text, held)
			continue
		}
		if failure, ok := err.(*Error); !ok || failure.Code != "E307" {
			t.Errorf("%q is refused with %v", text, err)
		}
	}
}

func TestAPathThatRunsIntoNothingStopsThere(t *testing.T) {
	document, err := model.Load("capture:\n  nothing:\n  cs:\n    State: Up\n")
	if err != nil {
		t.Fatal(err)
	}
	scope := NewScope(document.Value)
	if _, err := Evaluate("capture.nothing.deeper", scope); err == nil {
		t.Error("a path through nothing resolved")
	}
	// len() of an object is how many keys it has, which is the one place the
	// language looks at a mapping rather than through it.
	held, err := Evaluate("len(capture.cs)", scope)
	if err != nil || held != int64(1) {
		t.Errorf("len of an object is %v, %v", held, err)
	}
}

// contextRoots is the core's roots and two context keys an extension would
// add, as a composite hands them to NewScope.
var contextRoots = append(append([]string(nil), CoreRoots...), "region", "zone")

func TestAContextKeyIsARootOnlyWhenTheScopeIsGivenIt(t *testing.T) {
	// The core alone knows no context key beyond timeoutSec and defaults: a
	// product name such as a region is E301 until an extension adds it.
	if _, err := Evaluate("region", NewScope(scopeValue(t))); err == nil {
		t.Error("region resolved with the core's roots alone")
	} else if refused, ok := err.(*Error); !ok || refused.Code != "E301" {
		t.Errorf("region is refused with %v", err)
	}
	got, err := Evaluate("region", NewScope(scopeValue(t), contextRoots...))
	if err != nil || got != "eu-west" {
		t.Errorf("with the context key region is %v, %v", got, err)
	}
	for _, root := range []string{"capture", "param", "var", "row", "timeoutSec", "defaults"} {
		if !contains(CoreRoots, root) {
			t.Errorf("%s is not a core root", root)
		}
	}
	if len(CoreRoots) != 6 {
		t.Errorf("the core roots are %v", CoreRoots)
	}
}
