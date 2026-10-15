// Package value is one value as the text every binding writes it as.
//
// A suite compares values that arrived as YAML, as JSON from an API, and as
// whatever an action returned. The rules here are what keeps `equals` meaning
// the same thing in four languages: a whole number never grows a `.0`, a
// boolean is lowercase, and nothing at all is the empty string rather than the
// word null.
package value

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
)

// Text is a value as text.
func Text(value any) string {
	switch held := value.(type) {
	case nil:
		return ""
	case bool:
		if held {
			return "true"
		}
		return "false"
	case string:
		return held
	case int:
		return strconv.Itoa(held)
	case int64:
		return strconv.FormatInt(held, 10)
	case float64:
		return Number(held)
	case []any:
		parts := make([]string, 0, len(held))
		for _, item := range held {
			parts = append(parts, Text(item))
		}
		return strings.Join(parts, ", ")
	default:
		text, err := json.Marshal(value)
		if err != nil {
			return ""
		}
		return string(text)
	}
}

// Number is a float as text: a whole number keeps no decimal part, and a
// fraction keeps the shortest spelling that reads back as itself.
func Number(number float64) string {
	if number == math.Trunc(number) && math.Abs(number) < 9.2e18 {
		return strconv.FormatInt(int64(number), 10)
	}
	return strconv.FormatFloat(number, 'g', -1, 64)
}

// AsNumber reads a value as a number, when it is one.
func AsNumber(value any) (float64, bool) {
	switch held := value.(type) {
	case int:
		return float64(held), true
	case int64:
		return float64(held), true
	case float64:
		return held, true
	case string:
		number, err := strconv.ParseFloat(strings.TrimSpace(held), 64)
		return number, err == nil
	default:
		return 0, false
	}
}

// IsList says whether a value is a list, which several operators ask.
func IsList(value any) bool {
	_, ok := value.([]any)
	return ok
}

// AsMap reads a value as an object, when it is one.
func AsMap(value any) (*model.Map, bool) {
	held, ok := value.(*model.Map)
	return held, ok
}

// TextOf reads one key of an object as text.
func TextOf(value any, key string) string {
	held, ok := AsMap(value)
	if !ok {
		return ""
	}
	found, _ := held.Get(key)
	if text, ok := found.(string); ok {
		return text
	}
	return ""
}

// ListOf reads one key of an object as a list.
func ListOf(value any, key string) []any {
	held, ok := AsMap(value)
	if !ok {
		return nil
	}
	found, _ := held.Get(key)
	items, _ := found.([]any)
	return items
}

// Present says whether a key is there and is something.
func Present(value any, key string) bool {
	held, ok := AsMap(value)
	if !ok {
		return false
	}
	found, exists := held.Get(key)
	return exists && found != nil
}
