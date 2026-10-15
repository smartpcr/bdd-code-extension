package model

import (
	"encoding/json"
	"strconv"
	"strings"
)

// Map is an object that remembers the order its keys were written in.
//
// The order matters twice. It decides which of two findings in one object comes
// first, which the diagnostic sort then has to break ties on; and it decides
// what a captured value serialises to, which a report carries. Go's own map has
// no order at all, and deliberately randomises iteration.
type Map struct {
	keys   []string
	values map[string]any
}

// NewMap makes an empty one.
func NewMap() *Map {
	return &Map{values: map[string]any{}}
}

// Set writes one key, keeping its first position when it is already there.
func (ordered *Map) Set(key string, value any) {
	if _, found := ordered.values[key]; !found {
		ordered.keys = append(ordered.keys, key)
	}
	ordered.values[key] = value
}

// Get reads one key.
func (ordered *Map) Get(key string) (any, bool) {
	if ordered == nil {
		return nil, false
	}
	value, found := ordered.values[key]
	return value, found
}

// Value reads one key, or nothing.
func (ordered *Map) Value(key string) any {
	value, _ := ordered.Get(key)
	return value
}

// Has says whether a key is there at all, which is not the same as its value
// being something.
func (ordered *Map) Has(key string) bool {
	_, found := ordered.Get(key)
	return found
}

// Keys is the keys in the order they were written.
func (ordered *Map) Keys() []string {
	if ordered == nil {
		return nil
	}
	return append([]string(nil), ordered.keys...)
}

// Len is how many keys it holds.
func (ordered *Map) Len() int {
	if ordered == nil {
		return 0
	}
	return len(ordered.keys)
}

// Delete removes one key.
func (ordered *Map) Delete(key string) {
	if ordered == nil {
		return
	}
	if _, found := ordered.values[key]; !found {
		return
	}
	delete(ordered.values, key)
	for index, existing := range ordered.keys {
		if existing == key {
			ordered.keys = append(ordered.keys[:index], ordered.keys[index+1:]...)
			break
		}
	}
}

// Clone copies the map one level deep, which is what a step that is about to be
// rewritten needs.
func (ordered *Map) Clone() *Map {
	copied := NewMap()
	if ordered == nil {
		return copied
	}
	for _, key := range ordered.keys {
		copied.Set(key, ordered.values[key])
	}
	return copied
}

// MarshalJSON writes the keys in their own order rather than sorted, because
// that is the order the file declared them in.
func (ordered *Map) MarshalJSON() ([]byte, error) {
	if ordered == nil {
		return []byte("null"), nil
	}
	var out strings.Builder
	out.WriteByte('{')
	for index, key := range ordered.keys {
		if index > 0 {
			out.WriteByte(',')
		}
		name, err := json.Marshal(key)
		if err != nil {
			return nil, err
		}
		out.Write(name)
		out.WriteByte(':')
		value, err := json.Marshal(ordered.values[key])
		if err != nil {
			return nil, err
		}
		out.Write(value)
	}
	out.WriteByte('}')
	return []byte(out.String()), nil
}

// Pointer walks a JSON pointer into a value.
func Pointer(value any, pointer string) (any, bool) {
	if pointer == "" {
		return value, true
	}
	current := value
	for _, raw := range strings.Split(strings.TrimPrefix(pointer, "/"), "/") {
		segment := strings.ReplaceAll(strings.ReplaceAll(raw, "~1", "/"), "~0", "~")
		switch held := current.(type) {
		case *Map:
			found, ok := held.Get(segment)
			if !ok {
				return nil, false
			}
			current = found
		case []any:
			index, err := strconv.Atoi(segment)
			if err != nil || index < 0 || index >= len(held) {
				return nil, false
			}
			current = held[index]
		default:
			return nil, false
		}
	}
	return current, true
}

// Get reads one pointer out of a document.
func (document *Document) Get(pointer string) (any, bool) {
	return Pointer(document.Value, pointer)
}

// Plain is the same value with every ordered map turned into a plain one.
//
// The JSON Schema validator walks Go's own types and has never heard of Map,
// so the instance it is handed has to be flattened first. Key order is lost,
// which costs nothing: a validator reports by pointer, and the pointers are
// rebuilt against the ordered value afterwards.
func Plain(value any) any {
	switch held := value.(type) {
	case *Map:
		if held == nil {
			return nil
		}
		out := make(map[string]any, held.Len())
		for _, key := range held.Keys() {
			out[key] = Plain(held.Value(key))
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(held))
		for key, item := range held {
			out[key] = Plain(item)
		}
		return out
	case []any:
		out := make([]any, 0, len(held))
		for _, item := range held {
			out = append(out, Plain(item))
		}
		return out
	default:
		return value
	}
}
