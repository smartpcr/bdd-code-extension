// Package assertion is the assertion operators, and the one comparison rule
// each of them has.
//
// conformance/asserts/cases.yaml is the specification. `equals`
// comparing 3 with "3" as equal and `contains` ignoring case are decisions
// rather than accidents of the language this is written in, which is why they
// are data there rather than a paragraph here.
package assertion

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/value"
)

// Operators is every operator the comparer implements, which the reference
// renders and a test compares against the schema.
func Operators() []string {
	return []string{
		"equals", "notEquals", "contains", "notContains", "startsWith", "endsWith",
		"matches", "in", "gt", "gte", "lt", "lte", "count",
		"isTrue", "isFalse", "isNull", "isNotNull", "script",
	}
}

var backreference = regexp.MustCompile(`\\\d`)

// Unportable is the regular expression construct one of the four engines cannot
// run, and what to call it.
//
// Go's own RE2 is the narrowest of the four, so what it refuses is what the
// shared subset excludes. Detected by reading the pattern rather than by trying
// to compile it, because the other three engines compile all of these happily
// and the lint has to agree with them.
func Unportable(pattern string) string {
	if backreference.MatchString(pattern) {
		return "a backreference"
	}
	if strings.Contains(pattern, "(?=") || strings.Contains(pattern, "(?!") {
		return "a lookahead"
	}
	if strings.Contains(pattern, "(?<=") || strings.Contains(pattern, "(?<!") {
		return "a lookbehind"
	}
	return ""
}

// CompareError says why a pair could not be compared at all.
type CompareError struct {
	Code    string
	Message string
}

func (failure *CompareError) Error() string {
	if failure.Code == "" {
		return failure.Message
	}
	return failure.Code + ": " + failure.Message
}

func plain(message string) *CompareError { return &CompareError{Message: message} }

func coded(code, message string) *CompareError {
	return &CompareError{Code: code, Message: message}
}

func numberOr(held any, side, operator string) (float64, *CompareError) {
	if found, ok := value.AsNumber(held); ok {
		return found, nil
	}
	return 0, plain(fmt.Sprintf("%s compares numbers, and the %s is '%s', which is not one.",
		operator, side, value.Text(held)))
}

// Compare runs one operator against one actual value.
//
// `present` is whether the subject was there at all, which only isNull and
// isNotNull can tell apart from a subject that is there and null.
func Compare(operator string, actual, expected any, present bool) (bool, *CompareError) {
	wanted := func() string { return value.Text(expected) }
	subject := func() string { return value.Text(actual) }
	switch operator {
	case "equals":
		return strings.EqualFold(subject(), wanted()), nil
	case "notEquals":
		return !strings.EqualFold(subject(), wanted()), nil
	case "contains":
		if items, ok := actual.([]any); ok {
			for _, item := range items {
				if value.Text(item) == wanted() {
					return true, nil
				}
			}
			return false, nil
		}
		return strings.Contains(strings.ToLower(subject()), strings.ToLower(wanted())), nil
	case "notContains":
		yes, failure := Compare("contains", actual, expected, present)
		if failure != nil {
			return false, failure
		}
		return !yes, nil
	case "startsWith":
		return strings.HasPrefix(strings.ToLower(subject()), strings.ToLower(wanted())), nil
	case "endsWith":
		return strings.HasSuffix(strings.ToLower(subject()), strings.ToLower(wanted())), nil
	case "matches":
		if construct := Unportable(wanted()); construct != "" {
			return false, coded("E308", fmt.Sprintf(
				"the pattern '%s' uses %s, which is outside the subset the four bindings share.",
				wanted(), construct))
		}
		// Case-insensitive, which is what the suites were written against.
		pattern, err := regexp.Compile("(?i)" + wanted())
		if err != nil {
			return false, plain(fmt.Sprintf("the pattern '%s' cannot be read: %v", wanted(), err))
		}
		return pattern.MatchString(subject()), nil
	case "in":
		items, ok := expected.([]any)
		if !ok {
			return false, plain(fmt.Sprintf("in takes a list, and '%s' is not one.", wanted()))
		}
		for _, candidate := range items {
			if strings.EqualFold(value.Text(candidate), subject()) {
				return true, nil
			}
		}
		return false, nil
	case "gt", "gte", "lt", "lte":
		one, failure := numberOr(actual, "subject", operator)
		if failure != nil {
			return false, failure
		}
		other, failure := numberOr(expected, "expected value", operator)
		if failure != nil {
			return false, failure
		}
		switch operator {
		case "gt":
			return one > other, nil
		case "gte":
			return one >= other, nil
		case "lt":
			return one < other, nil
		default:
			return one <= other, nil
		}
	case "count":
		items, ok := actual.([]any)
		if !ok {
			return false, plain(fmt.Sprintf("count takes a list, and the subject is '%s', which is not one.", subject()))
		}
		howMany, failure := numberOr(expected, "expected value", "count")
		if failure != nil {
			return false, failure
		}
		return float64(len(items)) == howMany, nil
	case "isTrue":
		held, ok := actual.(bool)
		return (ok && held) == truthOf(expected), nil
	case "isFalse":
		held, ok := actual.(bool)
		return (ok && !held) == truthOf(expected), nil
	case "isNull":
		return (!present || actual == nil) == truthOf(expected), nil
	case "isNotNull":
		return (present && actual != nil) == truthOf(expected), nil
	default:
		return false, plain(fmt.Sprintf("Unknown assertion: %s", operator))
	}
}

// truthOf says what an operator's own expected value means when it is a flag.
func truthOf(held any) bool {
	switch found := held.(type) {
	case bool:
		return found
	case nil:
		return false
	default:
		text := value.Text(found)
		return text != "" && text != "0"
	}
}

// Describe says what a failed assertion said: the subject, the operator, what
// was expected and what was there.
func Describe(subject, operator string, expected, actual any, present bool) string {
	shown := ""
	switch {
	case !present:
		shown = "(absent)"
	case actual == nil:
		shown = "(null)"
	default:
		if items, ok := actual.([]any); ok {
			shown = "[" + joinText(items) + "]"
		} else {
			shown = value.Text(actual)
		}
	}
	wanted := value.Text(expected)
	if items, ok := expected.([]any); ok {
		wanted = "[" + joinText(items) + "]"
	}
	switch operator {
	case "isTrue":
		return fmt.Sprintf("expected %s to be true, got '%s'", subject, shown)
	case "isFalse":
		return fmt.Sprintf("expected %s to be false, got '%s'", subject, shown)
	case "isNull":
		return fmt.Sprintf("expected %s to be absent or null, got '%s'", subject, shown)
	case "isNotNull":
		return fmt.Sprintf("expected %s to be present, got '%s'", subject, shown)
	case "count":
		return fmt.Sprintf("expected %s to have %s entries, got '%s'", subject, wanted, shown)
	default:
		return fmt.Sprintf("expected %s %s '%s', got '%s'", subject, operator, wanted, shown)
	}
}

func joinText(items []any) string {
	parts := make([]string, 0, len(items))
	for _, item := range items {
		parts = append(parts, value.Text(item))
	}
	return strings.Join(parts, ", ")
}
