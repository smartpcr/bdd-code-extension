// Package model reads one suite file once, as a value and as a map of where
// everything is.
//
// Two things come out of a parse. The value is what the schema is checked
// against and what every pass walks. The position map is what turns a finding
// into a place an editor can go to: a JSON pointer to the line and column of
// the key that names a value and of the value itself, because a structural
// finding points at the misspelled key and a dataflow finding points at the
// value that carries the reference.
package model

import (
	"fmt"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Position is a one-based place in a file. Zero would be somewhere no editor
// can go to.
type Position struct {
	Line   int
	Column int
}

// NewPosition clamps both fields to one.
func NewPosition(line, column int) Position {
	if line < 1 {
		line = 1
	}
	if column < 1 {
		column = 1
	}
	return Position{Line: line, Column: column}
}

// Start is the position of a file that could not be read far enough to have one.
func Start() Position { return Position{Line: 1, Column: 1} }

// NodePosition is where a value and the key that names it are.
type NodePosition struct {
	Key   Position
	Value Position
}

// Document is a parsed suite: what it says, and where each part of it is.
type Document struct {
	Value     any
	Positions map[string]NodePosition
}

// At is the position of one pointer, or the start of the file when the pointer
// names nothing. A finding always has somewhere to point.
func (document *Document) At(pointer string) NodePosition {
	if found, ok := document.Positions[pointer]; ok {
		return found
	}
	return NodePosition{Key: Start(), Value: Start()}
}

// LoadError says why a file could not be read as a suite. Always E100: nothing
// below can be checked, so there is no second finding to report beside it.
type LoadError struct {
	Message  string
	Position Position
}

func (failure *LoadError) Error() string { return failure.Message }

// Escape is one pointer segment, escaped the way JSON pointers escape.
func Escape(segment string) string {
	return strings.ReplaceAll(strings.ReplaceAll(segment, "~", "~0"), "/", "~1")
}

// Child is a pointer built from a parent and one more segment.
func Child(parent, segment string) string {
	return parent + "/" + Escape(segment)
}

// Load reads one suite file.
func Load(text string) (*Document, error) {
	var root yaml.Node
	if err := yaml.Unmarshal([]byte(text), &root); err != nil {
		// The start of the file, not where this parser stopped. Four YAML
		// parsers stop in four places on the same broken file, and a position
		// two bindings cannot agree on is not a contract (diagnostics.md).
		return nil, &LoadError{Message: err.Error(), Position: Start()}
	}
	if len(root.Content) == 0 {
		return nil, &LoadError{Message: "the file holds no YAML document.", Position: Start()}
	}
	document := &Document{Positions: map[string]NodePosition{}}
	node := root.Content[0]
	document.Value = document.build(node, "")
	position := positionOf(node)
	document.Positions[""] = NodePosition{Key: position, Value: position}
	return document, nil
}

func positionOf(node *yaml.Node) Position {
	return NewPosition(node.Line, node.Column)
}

// build turns one node into a value, recording where each part of it is.
func (document *Document) build(node *yaml.Node, pointer string) any {
	switch node.Kind {
	case yaml.MappingNode:
		// yaml.v3 gives a mapping its first key's position, which is where a
		// reader would say it begins.
		result := NewMap()
		for index := 0; index+1 < len(node.Content); index += 2 {
			key := node.Content[index]
			value := node.Content[index+1]
			keyPointer := Child(pointer, key.Value)
			document.Positions[keyPointer] = NodePosition{
				Key:   positionOf(key),
				Value: positionOf(value),
			}
			result.Set(key.Value, document.build(value, keyPointer))
		}
		return result
	case yaml.SequenceNode:
		items := make([]any, 0, len(node.Content))
		for index, item := range node.Content {
			itemPointer := fmt.Sprintf("%s/%d", pointer, index)
			position := positionOf(item)
			document.Positions[itemPointer] = NodePosition{Key: position, Value: position}
			items = append(items, document.build(item, itemPointer))
		}
		return items
	case yaml.AliasNode:
		// An alias resolves to nothing here. The suite format has no use for
		// one, and a suite that used one is a suite two bindings would read
		// differently.
		return nil
	default:
		return scalar(node)
	}
}

// scalar resolves one YAML scalar to the value it names.
//
// The core schema: null and ~ and nothing at all are null, true and false are
// booleans, a whole number is an integer and a decimal one is a float. Anything
// quoted is a string whatever it looks like, which is what makes
// timeoutSec: "30" a type error rather than a number.
func scalar(node *yaml.Node) any {
	if node.Tag == "!!str" && node.Style != 0 {
		return node.Value
	}
	switch node.Tag {
	case "!!null":
		return nil
	case "!!bool":
		return node.Value == "true" || node.Value == "True" || node.Value == "TRUE"
	case "!!int":
		if number, err := strconv.ParseInt(node.Value, 0, 64); err == nil {
			return number
		}
	case "!!float":
		if number, err := strconv.ParseFloat(node.Value, 64); err == nil {
			return number
		}
	}
	if node.Style != 0 {
		return node.Value
	}
	switch node.Value {
	case "", "~", "null", "Null", "NULL":
		return nil
	case "true", "True", "TRUE":
		return true
	case "false", "False", "FALSE":
		return false
	}
	if number, err := strconv.ParseInt(node.Value, 10, 64); err == nil {
		return number
	}
	if number, err := strconv.ParseFloat(node.Value, 64); err == nil {
		return number
	}
	return node.Value
}
