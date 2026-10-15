// Package diag is one finding, and the two ways of writing a set of them.
//
// The codes and the positions are the contract between four bindings; the
// message wording is not (spec/diagnostics.md). Everything here
// follows from that: the sort is total so that two bindings that find the same
// problems write byte-identical JSON, and paths are relative with forward
// slashes so that three operating systems produce one string.
package diag

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
)

// Severity says whether a finding fails the validation, or only fails it under
// --strict.
type Severity string

const (
	Error   Severity = "error"
	Warning Severity = "warning"
)

// Diagnostic is one thing wrong with one suite.
type Diagnostic struct {
	Code       string
	Severity   Severity
	File       string
	Position   model.Position
	Message    string
	Suggestion string
}

// NewError builds one finding that fails the validation.
func NewError(code, file string, position model.Position, message string) Diagnostic {
	return Diagnostic{Code: code, Severity: Error, File: file, Position: position, Message: message}
}

// NewWarning builds one that only fails it under --strict.
func NewWarning(code, file string, position model.Position, message string) Diagnostic {
	finding := NewError(code, file, position, message)
	finding.Severity = Warning
	return finding
}

// Suggest adds the nearest legal spelling, when there is one. Never part of
// what two bindings are compared on: it is help, and help may differ.
func (finding Diagnostic) Suggest(suggestion string) Diagnostic {
	if suggestion != "" {
		finding.Suggestion = suggestion
	}
	return finding
}

// Human is `file:line:column  CODE  message`, with the suggestion indented
// under it.
func (finding Diagnostic) Human() string {
	head := fmt.Sprintf("%s:%d:%d  %s  %s",
		finding.File, finding.Position.Line, finding.Position.Column, finding.Code, finding.Message)
	if finding.Suggestion == "" {
		return head
	}
	return head + "\n    " + finding.Suggestion
}

// JSON is the object diagnostic.schema.json defines.
func (finding Diagnostic) JSON() *model.Map {
	out := model.NewMap()
	out.Set("code", finding.Code)
	out.Set("severity", string(finding.Severity))
	out.Set("file", finding.File)
	out.Set("line", finding.Position.Line)
	out.Set("column", finding.Position.Column)
	out.Set("message", finding.Message)
	if finding.Suggestion != "" {
		out.Set("suggestion", finding.Suggestion)
	}
	return out
}

// Less orders by file, then line, then column, then code, then message. Total,
// so that two bindings cannot disagree by ordering.
func Less(left, right Diagnostic) bool {
	if left.File != right.File {
		return left.File < right.File
	}
	if left.Position.Line != right.Position.Line {
		return left.Position.Line < right.Position.Line
	}
	if left.Position.Column != right.Position.Column {
		return left.Position.Column < right.Position.Column
	}
	if left.Code != right.Code {
		return left.Code < right.Code
	}
	return left.Message < right.Message
}

// Sorted is the same findings, in the one order every binding writes them in,
// each once.
//
// Two findings with the same file, position, code and message are one finding,
// as in the PowerShell binding. The structural pass checks a step's common
// fields twice (against the envelope, then against its action's branch), so a
// refused `why` would otherwise be reported twice.
func Sorted(findings []Diagnostic) []Diagnostic {
	out := append([]Diagnostic(nil), findings...)
	sort.SliceStable(out, func(one, other int) bool { return Less(out[one], out[other]) })
	unique := out[:0]
	for _, finding := range out {
		if len(unique) > 0 && !Less(unique[len(unique)-1], finding) {
			continue
		}
		unique = append(unique, finding)
	}
	return unique
}

// Fails says whether a set of findings fails the validation. A warning only
// does under --strict.
func Fails(findings []Diagnostic, strict bool) bool {
	for _, finding := range findings {
		if finding.Severity == Error || strict {
			return true
		}
	}
	return false
}

// JSONArray is the document `lint --json` writes.
func JSONArray(findings []Diagnostic) string {
	items := make([]any, 0, len(findings))
	for _, finding := range findings {
		items = append(items, finding.JSON())
	}
	text, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return "[]"
	}
	return string(text)
}

// RelativePath is a path as a diagnostic carries it: relative to the repository
// root when it is under it, and with forward slashes wherever it came from.
func RelativePath(full, root string) string {
	relative, err := filepath.Rel(root, full)
	if err != nil || strings.HasPrefix(relative, "..") {
		return strings.ReplaceAll(full, "\\", "/")
	}
	return strings.ReplaceAll(relative, "\\", "/")
}
