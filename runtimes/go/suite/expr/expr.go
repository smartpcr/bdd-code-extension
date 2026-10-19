// Package expr is the expression language, from ${...}.
//
// A tokeniser, a Pratt parser and a closed list of functions. The grammar is
// described in the design; conformance/expressions/cases.yaml is the
// specification, and when the two disagree the table is what four bindings are
// held to.
//
// Two rules decide what a string becomes. A string that is exactly one
// expression yields that expression's value with its type intact, so
// ${timeoutSec} is a number. A string with an expression inside other text is
// substituted into and stays a string.
package expr

import (
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/value"
)

// FunctionSpec is how many arguments one function takes, and whether it gives
// the same answer twice.
type FunctionSpec struct {
	Min           int
	Max           int
	Deterministic bool
}

// Functions is every function the language has.
//
// Closed because four bindings must agree; an open list would drift to whatever
// each language's standard library happens to call things. Matched
// case-sensitively, so LOWER is E306 rather than a second spelling.
var Functions = map[string]FunctionSpec{
	"lower":      {1, 1, true},
	"upper":      {1, 1, true},
	"trim":       {1, 1, true},
	"replace":    {3, 3, true},
	"format":     {1, 99, true},
	"split":      {2, 2, true},
	"join":       {2, 2, true},
	"startsWith": {2, 2, true},
	"endsWith":   {2, 2, true},
	"contains":   {2, 2, true},
	"len":        {1, 1, true},
	"first":      {1, 1, true},
	"last":       {1, 1, true},
	"int":        {1, 1, true},
	"float":      {1, 1, true},
	"str":        {1, 1, true},
	"bool":       {1, 1, true},
	"default":    {2, 2, true},
	"env":        {1, 1, false},
	"uuid":       {0, 0, false},
	"nowIso":     {0, 0, false},
}

// CoreRoots is every name a path may start at when no extension adds a
// context key. Anything else is E301. An extension's context keys are added to
// a scope with NewScope's roots.
var CoreRoots = []string{"capture", "param", "var", "row", "timeoutSec", "defaults"}

// FunctionNames is every function name, sorted, for a suggestion and for the
// reference.
func FunctionNames() []string {
	names := make([]string, 0, len(Functions))
	for name := range Functions {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Error is a refusal, carrying the code it is reported as.
type Error struct {
	Code    string
	Message string
}

func (failure *Error) Error() string { return failure.Code + ": " + failure.Message }

func refuse(code, message string) *Error { return &Error{Code: code, Message: message} }

type tokenKind int

const (
	tokenNumber tokenKind = iota
	tokenText
	tokenName
	tokenOperator
	tokenEnd
)

type token struct {
	kind   tokenKind
	text   string
	number any
}

func isNameStart(character rune) bool {
	return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || character == '_'
}

func isNameRest(character rune) bool {
	return isNameStart(character) || (character >= '0' && character <= '9')
}

func isDigit(character rune) bool { return character >= '0' && character <= '9' }

// Tokenise is one expression as the pieces it is made of, which the reference
// renders.
func Tokenise(text string) ([]string, error) {
	tokens, err := scan(text)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(tokens))
	for _, one := range tokens {
		switch one.kind {
		case tokenNumber:
			out = append(out, value.Text(one.number))
		case tokenEnd:
			out = append(out, "")
		default:
			out = append(out, one.text)
		}
	}
	return out, nil
}

func scan(text string) ([]token, error) {
	characters := []rune(text)
	tokens := []token{}
	at := 0
	for at < len(characters) {
		character := characters[at]
		if character == ' ' || character == '\t' || character == '\n' || character == '\r' {
			at++
			continue
		}
		if character == '\'' || character == '"' {
			quote := character
			var held strings.Builder
			at++
			closed := false
			for at < len(characters) {
				if characters[at] == quote {
					closed = true
					at++
					break
				}
				held.WriteRune(characters[at])
				at++
			}
			if !closed {
				return nil, refuse("E305", fmt.Sprintf("a string is never closed, in '%s'", text))
			}
			tokens = append(tokens, token{kind: tokenText, text: held.String()})
			continue
		}
		if isDigit(character) {
			var held strings.Builder
			for at < len(characters) {
				// A dot joins a number only when a digit follows, so that
				// sessionResults.0.value keeps its segments.
				joins := characters[at] == '.' && at+1 < len(characters) && isDigit(characters[at+1]) &&
					!strings.Contains(held.String(), ".")
				if !isDigit(characters[at]) && !joins {
					break
				}
				held.WriteRune(characters[at])
				at++
			}
			written := held.String()
			if strings.Contains(written, ".") {
				number, err := strconv.ParseFloat(written, 64)
				if err != nil {
					return nil, refuse("E305", fmt.Sprintf("'%s' is not a number this language can read, in '%s'", written, text))
				}
				tokens = append(tokens, token{kind: tokenNumber, number: number, text: written})
			} else {
				number, err := strconv.ParseInt(written, 10, 64)
				if err != nil {
					return nil, refuse("E305", fmt.Sprintf("'%s' is not a number this language can read, in '%s'", written, text))
				}
				tokens = append(tokens, token{kind: tokenNumber, number: number, text: written})
			}
			continue
		}
		if isNameStart(character) {
			var held strings.Builder
			for at < len(characters) && isNameRest(characters[at]) {
				held.WriteRune(characters[at])
				at++
			}
			tokens = append(tokens, token{kind: tokenName, text: held.String()})
			continue
		}
		end := at + 2
		if end > len(characters) {
			end = len(characters)
		}
		two := string(characters[at:end])
		if two == "==" || two == "!=" || two == "<=" || two == ">=" {
			tokens = append(tokens, token{kind: tokenOperator, text: two})
			at += 2
			continue
		}
		if strings.ContainsRune("+-*/%<>?:(),.", character) {
			tokens = append(tokens, token{kind: tokenOperator, text: string(character)})
			at++
			continue
		}
		return nil, refuse("E305", fmt.Sprintf("'%c' is not part of this language, at position %d of '%s'", character, at+1, text))
	}
	tokens = append(tokens, token{kind: tokenEnd})
	return tokens, nil
}

// Scope is how an expression is evaluated: against what, and whether a value
// that changes between runs is allowed.
type Scope struct {
	Value any
	// AllowNonDeterministic lets uuid, nowIso and env run. A vars value is
	// compared between runs, so it gets a scope where they are E309.
	AllowNonDeterministic bool
	// SyntaxOnly checks rather than runs. Every value underneath is a benign 1,
	// so a missing operand or an unclosed bracket is reported without a model.
	SyntaxOnly bool
	// Roots is every name a path may start at: the core's and the
	// extensions' context keys. CoreRoots when empty.
	Roots []string
}

// NewScope is a scope that runs an expression against one value. The roots a
// path may start at are the given ones (the core's and every extension's
// context keys), or CoreRoots when none are given.
func NewScope(against any, roots ...string) *Scope {
	return &Scope{Value: against, AllowNonDeterministic: true, Roots: roots}
}

// roots is the roots this scope allows.
func (scope *Scope) roots() []string {
	if len(scope.Roots) == 0 {
		return CoreRoots
	}
	return scope.Roots
}

// Stable is the same scope with the non-deterministic functions refused.
func (scope *Scope) Stable() *Scope {
	copied := *scope
	copied.AllowNonDeterministic = false
	return &copied
}

type parser struct {
	tokens []token
	at     int
	source string
	scope  *Scope
}

func (reader *parser) peek() token {
	if reader.at < len(reader.tokens) {
		return reader.tokens[reader.at]
	}
	return token{kind: tokenEnd}
}

func (reader *parser) next() token {
	found := reader.peek()
	reader.at++
	return found
}

func (reader *parser) isOperator(values ...string) bool {
	found := reader.peek()
	if found.kind != tokenOperator && found.kind != tokenName {
		return false
	}
	for _, wanted := range values {
		if found.text == wanted {
			return true
		}
	}
	return false
}

func (reader *parser) ternary() (any, error) {
	condition, err := reader.or()
	if err != nil {
		return nil, err
	}
	if reader.isOperator("?") {
		reader.at++
		taken := true
		if !reader.scope.SyntaxOnly {
			taken, err = truthy(condition)
			if err != nil {
				return nil, err
			}
		}
		whenTrue, err := reader.ternaryBranch(taken)
		if err != nil {
			return nil, err
		}
		if !reader.isOperator(":") {
			return nil, refuse("E305", fmt.Sprintf("a ? needs a : after it, in '%s'", reader.source))
		}
		reader.at++
		whenFalse, err := reader.ternaryBranch(!taken)
		if err != nil {
			return nil, err
		}
		if reader.scope.SyntaxOnly {
			return whenTrue, nil
		}
		if taken {
			return whenTrue, nil
		}
		return whenFalse, nil
	}
	return condition, nil
}

func (reader *parser) ternaryBranch(evaluate bool) (any, error) {
	if evaluate || reader.scope.SyntaxOnly {
		return reader.ternary()
	}
	scope := *reader.scope
	scope.SyntaxOnly = true
	skipped := parser{tokens: reader.tokens, at: reader.at, source: reader.source, scope: &scope}
	result, err := skipped.ternary()
	reader.at = skipped.at
	return result, err
}

func (reader *parser) or() (any, error) {
	left, err := reader.and()
	if err != nil {
		return nil, err
	}
	for reader.isOperator("or") {
		reader.at++
		right, err := reader.and()
		if err != nil {
			return nil, err
		}
		one, err := truthy(left)
		if err != nil {
			return nil, err
		}
		other, err := truthy(right)
		if err != nil {
			return nil, err
		}
		left = one || other
	}
	return left, nil
}

func (reader *parser) and() (any, error) {
	left, err := reader.comparison()
	if err != nil {
		return nil, err
	}
	for reader.isOperator("and") {
		reader.at++
		right, err := reader.comparison()
		if err != nil {
			return nil, err
		}
		one, err := truthy(left)
		if err != nil {
			return nil, err
		}
		other, err := truthy(right)
		if err != nil {
			return nil, err
		}
		left = one && other
	}
	return left, nil
}

// comparison reads one comparison, and only one. `1 < 2 == true` is refused
// rather than read as something, because two bindings would chain it
// differently.
func (reader *parser) comparison() (any, error) {
	left, err := reader.additive()
	if err != nil {
		return nil, err
	}
	for _, operator := range []string{"==", "!=", "<=", ">=", "<", ">"} {
		if reader.isOperator(operator) {
			reader.at++
			right, err := reader.additive()
			if err != nil {
				return nil, err
			}
			return compare(operator, left, right, reader.scope.SyntaxOnly)
		}
	}
	return left, nil
}

func (reader *parser) additive() (any, error) {
	left, err := reader.multiplicative()
	if err != nil {
		return nil, err
	}
	for {
		switch {
		case reader.isOperator("+"):
			reader.at++
			right, err := reader.multiplicative()
			if err != nil {
				return nil, err
			}
			left, err = add(left, right, reader.scope.SyntaxOnly)
			if err != nil {
				return nil, err
			}
		case reader.isOperator("-"):
			reader.at++
			right, err := reader.multiplicative()
			if err != nil {
				return nil, err
			}
			left, err = arithmetic("-", left, right, reader.scope.SyntaxOnly)
			if err != nil {
				return nil, err
			}
		default:
			return left, nil
		}
	}
}

func (reader *parser) multiplicative() (any, error) {
	left, err := reader.unary()
	if err != nil {
		return nil, err
	}
	for {
		operator := ""
		switch {
		case reader.isOperator("*"):
			operator = "*"
		case reader.isOperator("/"):
			operator = "/"
		case reader.isOperator("%"):
			operator = "%"
		default:
			return left, nil
		}
		reader.at++
		right, err := reader.unary()
		if err != nil {
			return nil, err
		}
		left, err = arithmetic(operator, left, right, reader.scope.SyntaxOnly)
		if err != nil {
			return nil, err
		}
	}
}

func (reader *parser) unary() (any, error) {
	if reader.isOperator("-") {
		reader.at++
		held, err := reader.unary()
		if err != nil {
			return nil, err
		}
		return arithmetic("-", int64(0), held, reader.scope.SyntaxOnly)
	}
	if reader.isOperator("not") {
		reader.at++
		held, err := reader.unary()
		if err != nil {
			return nil, err
		}
		if reader.scope.SyntaxOnly {
			return true, nil
		}
		yes, err := truthy(held)
		if err != nil {
			return nil, err
		}
		return !yes, nil
	}
	return reader.primary()
}

func (reader *parser) primary() (any, error) {
	found := reader.next()
	switch found.kind {
	case tokenNumber:
		return found.number, nil
	case tokenText:
		return found.text, nil
	case tokenOperator:
		if found.text == "(" {
			inside, err := reader.ternary()
			if err != nil {
				return nil, err
			}
			if !reader.isOperator(")") {
				return nil, refuse("E305", fmt.Sprintf("a ( is never closed, in '%s'", reader.source))
			}
			reader.at++
			return inside, nil
		}
		return nil, refuse("E305", fmt.Sprintf("'%s' has nothing to work on, in '%s'", found.text, reader.source))
	case tokenName:
		switch found.text {
		case "true":
			return true, nil
		case "false":
			return false, nil
		case "null":
			return nil, nil
		}
		if reader.isOperator("(") {
			reader.at++
			arguments := []any{}
			if !reader.isOperator(")") {
				for {
					argument, err := reader.ternary()
					if err != nil {
						return nil, err
					}
					arguments = append(arguments, argument)
					if reader.isOperator(",") {
						reader.at++
						continue
					}
					break
				}
			}
			if !reader.isOperator(")") {
				return nil, refuse("E305", fmt.Sprintf("a call to %s is never closed, in '%s'", found.text, reader.source))
			}
			reader.at++
			return call(found.text, arguments, reader.scope)
		}
		segments := []string{found.text}
		for reader.isOperator(".") {
			reader.at++
			segment := reader.next()
			switch segment.kind {
			case tokenName:
				segments = append(segments, segment.text)
			case tokenNumber:
				segments = append(segments, value.Text(segment.number))
			default:
				return nil, refuse("E305", fmt.Sprintf("a path ends with a dot, in '%s'", reader.source))
			}
		}
		return resolve(segments, reader.scope)
	default:
		return nil, refuse("E305", fmt.Sprintf("'%s' ends before it says anything", reader.source))
	}
}

// truthy says whether a value counts as true, by the one rule bool() states.
func truthy(held any) (bool, error) {
	if yes, ok := toBool(held); ok {
		return yes, nil
	}
	return false, refuse("E307", fmt.Sprintf("bool cannot read '%s' as true or false", value.Text(held)))
}

func toBool(held any) (bool, bool) {
	if yes, ok := held.(bool); ok {
		return yes, true
	}
	switch strings.ToLower(strings.TrimSpace(value.Text(held))) {
	case "true", "yes", "1":
		return true, true
	case "false", "no", "0", "":
		return false, true
	}
	return false, false
}

// isFloat says whether a value carries a fraction, which decides whether an
// arithmetic result keeps one.
func isFloat(held any) bool {
	switch found := held.(type) {
	case float64:
		return true
	case int, int64:
		return false
	case string:
		trimmed := strings.TrimSpace(found)
		if _, err := strconv.ParseInt(trimmed, 10, 64); err == nil {
			return false
		}
		_, err := strconv.ParseFloat(trimmed, 64)
		return err == nil
	default:
		return false
	}
}

func number(result float64, whole bool) any {
	if whole && result == math.Trunc(result) && math.Abs(result) < 9.2e18 {
		return int64(result)
	}
	return result
}

// add is numeric when both sides are numbers and textual otherwise.
func add(left, right any, syntaxOnly bool) (any, error) {
	if syntaxOnly {
		return int64(1), nil
	}
	one, oneIsNumber := value.AsNumber(left)
	other, otherIsNumber := value.AsNumber(right)
	if oneIsNumber && otherIsNumber {
		return number(one+other, !isFloat(left) && !isFloat(right)), nil
	}
	return value.Text(left) + value.Text(right), nil
}

func arithmetic(operator string, left, right any, syntaxOnly bool) (any, error) {
	if syntaxOnly {
		return int64(1), nil
	}
	one, oneIsNumber := value.AsNumber(left)
	other, otherIsNumber := value.AsNumber(right)
	if !oneIsNumber || !otherIsNumber {
		return nil, refuse("E307", fmt.Sprintf("%s takes numbers, and '%s' or '%s' is not one",
			operator, value.Text(left), value.Text(right)))
	}
	whole := !isFloat(left) && !isFloat(right)
	switch operator {
	case "-":
		return number(one-other, whole), nil
	case "*":
		return number(one*other, whole), nil
	case "/":
		if other == 0 {
			return nil, refuse("E307", "division by zero")
		}
		return number(one/other, whole), nil
	case "%":
		if other == 0 {
			return nil, refuse("E307", "division by zero")
		}
		return number(math.Mod(one, other), whole), nil
	default:
		return nil, refuse("E305", fmt.Sprintf("'%s' is not an operator", operator))
	}
}

// compare reads numbers as numbers; anything else compares as text, ignoring
// case, which is what the suites in the tree were written against.
func compare(operator string, left, right any, syntaxOnly bool) (any, error) {
	if syntaxOnly {
		return true, nil
	}
	one, oneIsNumber := value.AsNumber(left)
	other, otherIsNumber := value.AsNumber(right)
	numeric := oneIsNumber && otherIsNumber
	switch operator {
	case "==":
		if numeric {
			return one == other, nil
		}
		return strings.EqualFold(value.Text(left), value.Text(right)), nil
	case "!=":
		if numeric {
			return one != other, nil
		}
		return !strings.EqualFold(value.Text(left), value.Text(right)), nil
	}
	if !numeric {
		return nil, refuse("E307", fmt.Sprintf("%s compares numbers, and '%s' or '%s' is not one",
			operator, value.Text(left), value.Text(right)))
	}
	switch operator {
	case "<":
		return one < other, nil
	case "<=":
		return one <= other, nil
	case ">":
		return one > other, nil
	default:
		return one >= other, nil
	}
}

// Field reads one named member of a value, whether it arrived from YAML as an
// ordered map or from JSON as a plain one.
func Field(held any, key string) (any, bool) {
	switch found := held.(type) {
	case *model.Map:
		return found.Get(key)
	case map[string]any:
		got, ok := found[key]
		return got, ok
	default:
		return nil, false
	}
}

// resolve walks one path against the scope.
func resolve(segments []string, scope *Scope) (any, error) {
	whole := strings.Join(segments, ".")
	if scope.SyntaxOnly {
		return int64(1), nil
	}
	root := segments[0]
	roots := scope.roots()
	if !contains(roots, root) {
		return nil, refuse("E301", fmt.Sprintf("${%s} resolves to nothing. A path starts at %s.",
			whole, strings.Join(roots, ", ")))
	}
	current := scope.Value
	for _, segment := range segments {
		if current == nil {
			return nil, refuse("E301", fmt.Sprintf("${%s} resolves to nothing.", whole))
		}
		if items, ok := current.([]any); ok {
			if index, err := strconv.Atoi(segment); err == nil {
				if index < 0 || index >= len(items) {
					return nil, refuse("E301", fmt.Sprintf("${%s} resolves to nothing: the list has %d entries.", whole, len(items)))
				}
				current = items[index]
				continue
			}
		}
		found, ok := Field(current, segment)
		if !ok {
			return nil, refuse("E301", fmt.Sprintf("${%s} resolves to nothing: no %s there.", whole, segment))
		}
		current = found
	}
	return current, nil
}

func asList(held any) []any {
	switch found := held.(type) {
	case []any:
		return found
	case nil:
		return []any{}
	default:
		return []any{found}
	}
}

func contains(list []string, wanted string) bool {
	for _, item := range list {
		if item == wanted {
			return true
		}
	}
	return false
}

// call runs one function of the closed list.
func call(name string, arguments []any, scope *Scope) (any, error) {
	spec, declared := Functions[name]
	if !declared {
		prefix := strings.ToLower(name)
		if len(prefix) > 2 {
			prefix = prefix[:2]
		}
		suggestion := ""
		for _, candidate := range FunctionNames() {
			if strings.HasPrefix(strings.ToLower(candidate), prefix) {
				suggestion = fmt.Sprintf(" Did you mean %s?", candidate)
				break
			}
		}
		return nil, refuse("E306", fmt.Sprintf("there is no function called %s.%s", name, suggestion))
	}
	if len(arguments) < spec.Min || len(arguments) > spec.Max {
		expected := strconv.Itoa(spec.Min)
		if spec.Min != spec.Max {
			expected = fmt.Sprintf("%d to %d", spec.Min, spec.Max)
		}
		return nil, refuse("E307", fmt.Sprintf("%s takes %s argument(s), not %d", name, expected, len(arguments)))
	}
	if !spec.Deterministic && !scope.AllowNonDeterministic {
		return nil, refuse("E309", fmt.Sprintf("%s is not deterministic, and this value has to be stable", name))
	}
	if scope.SyntaxOnly {
		return int64(1), nil
	}

	text := func(index int) string { return value.Text(arguments[index]) }
	switch name {
	case "lower":
		return strings.ToLower(text(0)), nil
	case "upper":
		return strings.ToUpper(text(0)), nil
	case "trim":
		return strings.TrimSpace(text(0)), nil
	case "replace":
		return strings.ReplaceAll(text(0), text(1), text(2)), nil
	case "format":
		out := text(0)
		for index := 1; index < len(arguments); index++ {
			out = strings.ReplaceAll(out, fmt.Sprintf("{%d}", index-1), value.Text(arguments[index]))
		}
		return out, nil
	case "split":
		pieces := strings.Split(text(0), text(1))
		out := make([]any, 0, len(pieces))
		for _, piece := range pieces {
			out = append(out, piece)
		}
		return out, nil
	case "join":
		items := asList(arguments[0])
		parts := make([]string, 0, len(items))
		for _, item := range items {
			parts = append(parts, value.Text(item))
		}
		return strings.Join(parts, text(1)), nil
	case "startsWith":
		return strings.HasPrefix(strings.ToLower(text(0)), strings.ToLower(text(1))), nil
	case "endsWith":
		return strings.HasSuffix(strings.ToLower(text(0)), strings.ToLower(text(1))), nil
	case "contains":
		if items, ok := arguments[0].([]any); ok {
			for _, item := range items {
				if value.Text(item) == text(1) {
					return true, nil
				}
			}
			return false, nil
		}
		return strings.Contains(strings.ToLower(text(0)), strings.ToLower(text(1))), nil
	case "len":
		switch held := arguments[0].(type) {
		case nil:
			return int64(0), nil
		case string:
			return int64(len([]rune(held))), nil
		case []any:
			return int64(len(held)), nil
		case *model.Map:
			return int64(held.Len()), nil
		case map[string]any:
			return int64(len(held)), nil
		default:
			return nil, refuse("E307", "len takes a string or a list")
		}
	case "first", "last":
		items := asList(arguments[0])
		if len(items) == 0 {
			return nil, refuse("E307", fmt.Sprintf("%s takes a list with something in it", name))
		}
		if name == "first" {
			return items[0], nil
		}
		return items[len(items)-1], nil
	case "int":
		if found, ok := value.AsNumber(arguments[0]); ok {
			return int64(math.Trunc(found)), nil
		}
		return nil, refuse("E307", fmt.Sprintf("int cannot read '%s' as a number", text(0)))
	case "float":
		if found, ok := value.AsNumber(arguments[0]); ok {
			return found, nil
		}
		return nil, refuse("E307", fmt.Sprintf("float cannot read '%s' as a number", text(0)))
	case "str":
		return text(0), nil
	case "bool":
		if yes, ok := toBool(arguments[0]); ok {
			return yes, nil
		}
		return nil, refuse("E307", fmt.Sprintf("bool cannot read '%s' as true or false", text(0)))
	case "default":
		first := arguments[0]
		if first == nil || value.Text(first) == "" {
			return arguments[1], nil
		}
		return first, nil
	case "env":
		return os.Getenv(text(0)), nil
	case "uuid":
		return newIdentifier(), nil
	case "nowIso":
		return time.Now().UTC().Format("2006-01-02T15:04:05Z"), nil
	default:
		return nil, refuse("E306", fmt.Sprintf("there is no function called %s.", name))
	}
}

// newIdentifier is a 32-character identifier, from the clock and a counter. A
// test tool needs an identifier nobody else has this second, not a
// cryptographic one, and this avoids a dependency for one function.
func newIdentifier() string {
	return fmt.Sprintf("%016x%016x", time.Now().UnixNano(), minted.Add(1))
}

// minted counts identifiers; sessions may evaluate expressions concurrently.
var minted atomic.Int64

// Evaluate runs one expression.
func Evaluate(text string, scope *Scope) (any, error) {
	tokens, err := scan(text)
	if err != nil {
		return nil, err
	}
	reader := &parser{tokens: tokens, source: text, scope: scope}
	result, err := reader.ternary()
	if err != nil {
		return nil, err
	}
	left := reader.peek()
	if left.kind == tokenEnd {
		return result, nil
	}
	shown := left.text
	if left.kind == tokenNumber {
		shown = value.Text(left.number)
	}
	return nil, refuse("E305", fmt.Sprintf("'%s' is left over at the end of '%s'", shown, text))
}

// Expand is one value with every ${...} in it substituted.
//
// A string that is exactly one expression keeps that expression's type; a
// string with an expression inside text becomes a string.
func Expand(held any, scope *Scope) (any, error) {
	switch found := held.(type) {
	case string:
		trimmed := strings.TrimSpace(found)
		if found == trimmed && strings.HasPrefix(trimmed, "${") && strings.HasSuffix(trimmed, "}") {
			inside := found[2 : len(found)-1]
			if !strings.Contains(inside, "${") {
				return Evaluate(inside, scope)
			}
		}
		var out strings.Builder
		characters := []rune(found)
		at := 0
		for at < len(characters) {
			if characters[at] == '$' && at+1 < len(characters) && characters[at+1] == '{' {
				end := at + 2
				for end < len(characters) && characters[end] != '}' {
					end++
				}
				if end < len(characters) {
					result, err := Evaluate(string(characters[at+2:end]), scope)
					if err != nil {
						return nil, err
					}
					out.WriteString(value.Text(result))
					at = end + 1
					continue
				}
			}
			out.WriteRune(characters[at])
			at++
		}
		return out.String(), nil
	case []any:
		expanded := make([]any, 0, len(found))
		for _, item := range found {
			one, err := Expand(item, scope)
			if err != nil {
				return nil, err
			}
			expanded = append(expanded, one)
		}
		return expanded, nil
	case *model.Map:
		expanded := model.NewMap()
		for _, key := range found.Keys() {
			one, err := Expand(found.Value(key), scope)
			if err != nil {
				return nil, err
			}
			expanded.Set(key, one)
		}
		return expanded, nil
	default:
		return held, nil
	}
}

// Reference is one ${...} and the pointer it was written at.
type Reference struct {
	Pointer    string
	Expression string
}

// References is every ${...} in a value, with the pointer it was written at.
func References(held any, pointer string) []Reference {
	found := []Reference{}
	switch value := held.(type) {
	case string:
		characters := []rune(value)
		at := 0
		for at < len(characters) {
			if characters[at] == '$' && at+1 < len(characters) && characters[at+1] == '{' {
				end := at + 2
				for end < len(characters) && characters[end] != '}' {
					end++
				}
				if end < len(characters) {
					found = append(found, Reference{Pointer: pointer, Expression: string(characters[at+2 : end])})
					at = end + 1
					continue
				}
			}
			at++
		}
	case []any:
		for index, item := range value {
			found = append(found, References(item, fmt.Sprintf("%s/%d", pointer, index))...)
		}
	case *model.Map:
		for _, key := range value.Keys() {
			found = append(found, References(value.Value(key), model.Child(pointer, key))...)
		}
	}
	return found
}

// Reading is the paths and the function names one expression names.
type Reading struct {
	Paths     [][]string
	Functions []string
	Err       *Error
}

// Read says what one expression reads, and whether it parses at all.
func Read(text string, stable bool) Reading {
	reading := Reading{}
	tokens, err := scan(text)
	if err != nil {
		reading.Err = err.(*Error)
		return reading
	}
	scope := &Scope{Value: nil, AllowNonDeterministic: !stable, SyntaxOnly: true}
	if _, err := Evaluate(text, scope); err != nil {
		reading.Err = err.(*Error)
		return reading
	}
	keywords := []string{"and", "or", "not", "true", "false", "null"}
	at := 0
	for at < len(tokens) {
		if tokens[at].kind != tokenName {
			at++
			continue
		}
		name := tokens[at].text
		if contains(keywords, name) {
			at++
			continue
		}
		if at+1 < len(tokens) && tokens[at+1].kind == tokenOperator && tokens[at+1].text == "(" {
			reading.Functions = append(reading.Functions, name)
			at++
			continue
		}
		segments := []string{name}
		at++
	path:
		for at < len(tokens) && tokens[at].kind == tokenOperator && tokens[at].text == "." {
			if at+1 >= len(tokens) {
				break
			}
			switch tokens[at+1].kind {
			case tokenName:
				segments = append(segments, tokens[at+1].text)
				at += 2
			case tokenNumber:
				segments = append(segments, value.Text(tokens[at+1].number))
				at += 2
			default:
				break path
			}
		}
		reading.Paths = append(reading.Paths, segments)
	}
	return reading
}
