// The canonical report form, implemented here rather than in the binding.
//
// conformance/report/canonicalise.md is the definition all four
// bindings implement from. It lives in the test because the shipped output
// keeps its timestamps: a person reading a report wants them, and only a
// comparison does not.

package conformance

import (
	"encoding/json"
	"sort"
	"strings"
	"testing"
	"unicode"
)

// volatileAttributes is when, how long, and on what. None of it is behaviour.
var volatileAttributes = []string{
	"start-time", "end-time", "duration", "time", "timestamp",
	"hostname", "id", "clr-version", "engine-version",
}

// A stack trace belongs to the host runtime rather than to the suite, and JUnit
// puts the same thing in the text of a failure.
var volatileElements = []string{"stack-trace"}
var textlessElements = []string{"failure"}

// element is a small reader, which is all a report needs: elements, attributes
// and text, with no namespaces and no entities beyond the five.
type element struct {
	name       string
	attributes [][2]string
	children   []*element
	text       string
}

func unescape(text string) string {
	return strings.NewReplacer(
		"&lt;", "<", "&gt;", ">", "&quot;", `"`, "&apos;", "'", "&amp;", "&",
	).Replace(text)
}

func parseXML(t *testing.T, document string) *element {
	t.Helper()
	characters := []rune(document)
	at := 0
	stack := []*element{}
	var root *element
	for at < len(characters) {
		if characters[at] != '<' {
			start := at
			for at < len(characters) && characters[at] != '<' {
				at++
			}
			if len(stack) > 0 {
				stack[len(stack)-1].text += unescape(string(characters[start:at]))
			}
			continue
		}
		start := at
		for at < len(characters) && characters[at] != '>' {
			at++
		}
		tag := string(characters[start+1 : min(at, len(characters))])
		at++
		if strings.HasPrefix(tag, "?") || strings.HasPrefix(tag, "!") {
			continue
		}
		if name, closing := strings.CutPrefix(tag, "/"); closing {
			if len(stack) == 0 {
				t.Fatal("a closing tag with nothing open")
			}
			finished := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if finished.name != strings.TrimSpace(name) {
				t.Fatalf("tags are not balanced: %s closed by %s", finished.name, name)
			}
			if len(stack) > 0 {
				stack[len(stack)-1].children = append(stack[len(stack)-1].children, finished)
			} else {
				root = finished
			}
			continue
		}
		empty := strings.HasSuffix(tag, "/")
		body := strings.TrimSuffix(tag, "/")
		name, rest, _ := strings.Cut(body, " ")
		held := &element{name: strings.TrimSpace(name)}
		held.attributes = parseAttributes(rest)
		if empty {
			if len(stack) > 0 {
				stack[len(stack)-1].children = append(stack[len(stack)-1].children, held)
			} else {
				root = held
			}
			continue
		}
		stack = append(stack, held)
	}
	if root == nil {
		t.Fatal("a report has a root element")
	}
	return root
}

func parseAttributes(rest string) [][2]string {
	attributes := [][2]string{}
	characters := []rune(rest)
	index := 0
	for index < len(characters) {
		for index < len(characters) && unicode.IsSpace(characters[index]) {
			index++
		}
		start := index
		for index < len(characters) && characters[index] != '=' {
			index++
		}
		if index >= len(characters) {
			break
		}
		key := string(characters[start:index])
		// Past the equals sign and the opening quote.
		index += 2
		start = index
		for index < len(characters) && characters[index] != '"' {
			index++
		}
		value := string(characters[start:min(index, len(characters))])
		index++
		attributes = append(attributes, [2]string{strings.TrimSpace(key), unescape(value)})
	}
	return attributes
}

// sortedJSONLine is one line of captured output, with a JSON object's keys put
// in order.
//
// What a step captured is behaviour; the order a hash map happened to enumerate
// it in is not, and four bindings enumerate in four orders.
func sortedJSONLine(line string) string {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "{") || !strings.HasSuffix(trimmed, "}") {
		return line
	}
	var parsed any
	if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil {
		return line
	}
	// Go's own encoder sorts a map's keys, which is exactly the rule the
	// canonical form states.
	text, err := json.Marshal(parsed)
	if err != nil {
		return line
	}
	return string(text)
}

func canonicalLines(held *element, depth int, lines *[]string) {
	indent := strings.Repeat("  ", depth)
	attributes := []string{}
	for _, pair := range held.attributes {
		if containsText(volatileAttributes, pair[0]) {
			continue
		}
		attributes = append(attributes, pair[0]+`="`+strings.ReplaceAll(pair[1], "\r\n", "\n")+`"`)
	}
	sort.Strings(attributes)
	open := held.name
	if len(attributes) > 0 {
		open = held.name + " " + strings.Join(attributes, " ")
	}
	children := []*element{}
	for _, child := range held.children {
		if !containsText(volatileElements, child.name) {
			children = append(children, child)
		}
	}
	text := ""
	if !containsText(textlessElements, held.name) {
		flat := strings.Split(strings.TrimSpace(strings.ReplaceAll(held.text, "\r\n", "\n")), "\n")
		for index, line := range flat {
			flat[index] = sortedJSONLine(line)
		}
		text = strings.Join(flat, "\n")
	}

	if len(children) == 0 && text == "" {
		*lines = append(*lines, indent+"<"+open+"/>")
		return
	}
	if len(children) == 0 {
		flat := strings.Split(text, "\n")
		for index, line := range flat {
			flat[index] = strings.TrimRight(line, " \t")
		}
		if len(flat) == 1 {
			*lines = append(*lines, indent+"<"+open+">"+flat[0]+"</"+held.name+">")
			return
		}
		*lines = append(*lines, indent+"<"+open+">")
		for _, line := range flat {
			*lines = append(*lines, strings.Repeat("  ", depth+1)+line)
		}
		*lines = append(*lines, indent+"</"+held.name+">")
		return
	}
	*lines = append(*lines, indent+"<"+open+">")
	if text != "" {
		*lines = append(*lines, strings.Repeat("  ", depth+1)+text)
	}
	for _, child := range children {
		canonicalLines(child, depth+1, lines)
	}
	*lines = append(*lines, indent+"</"+held.name+">")
}

func canonicalise(t *testing.T, document string) string {
	t.Helper()
	lines := []string{}
	canonicalLines(parseXML(t, document), 0, &lines)
	return strings.Join(lines, "\n") + "\n"
}

func containsText(list []string, wanted string) bool {
	for _, item := range list {
		if item == wanted {
			return true
		}
	}
	return false
}

func TestTwoRunsThatDifferOnlyInWhatTheyMeasuredCanonicaliseEqual(t *testing.T) {
	stamped := `<test-run id="2" start-time="2026-01-01 00:00:00Z" duration="9.000" total="1"><test-case id="0-1" name="c" result="Passed" duration="9.000"/></test-run>`
	later := strings.NewReplacer(
		"2026-01-01 00:00:00Z", "2026-06-30 11:22:33Z",
		"9.000", "0.125",
		`id="2"`, `id="7"`,
	).Replace(stamped)
	if canonicalise(t, stamped) != canonicalise(t, later) {
		t.Error("two runs of the same suite canonicalise differently")
	}
	changed := strings.ReplaceAll(stamped, `result="Passed"`, `result="Failed"`)
	if canonicalise(t, stamped) == canonicalise(t, changed) {
		t.Error("a different result canonicalises the same")
	}
}

func TestAStackTraceAndAFailuresTextAreDroppedAndItsMessageIsNot(t *testing.T) {
	document := `<r><test-case name="c"><failure><message>why</message><stack-trace>at somewhere:1</stack-trace></failure></test-case></r>`
	canonical := canonicalise(t, document)
	if !strings.Contains(canonical, "<message>why</message>") {
		t.Errorf("the message was dropped:\n%s", canonical)
	}
	if strings.Contains(canonical, "stack-trace") {
		t.Errorf("the stack trace was kept:\n%s", canonical)
	}
	junit := `<r><testcase name="c"><failure message="why">at somewhere:1</failure></testcase></r>`
	canonical = canonicalise(t, junit)
	if !strings.Contains(canonical, `message="why"`) {
		t.Errorf("the JUnit message was dropped:\n%s", canonical)
	}
	if strings.Contains(canonical, "somewhere") {
		t.Errorf("the JUnit failure text was kept:\n%s", canonical)
	}
}
