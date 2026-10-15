// The expression table, row by row.
//
// conformance/expressions/cases.yaml is the specification. Every row
// states a value and its type, or the code it is refused with, and this binding
// is held to all of them.

package conformance

import (
	"fmt"
	"strings"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/where"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/expr"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/value"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

// kind is what the table calls the type of a produced value.
func kind(produced any) string {
	switch produced.(type) {
	case nil:
		return "null"
	case bool:
		return "bool"
	case string:
		return "string"
	case int64, int:
		return "int"
	case float64:
		return "float"
	case []any:
		return "list"
	case *model.Map:
		return "object"
	default:
		return fmt.Sprintf("%T", produced)
	}
}

// same compares a produced value with the one the table states, by the same
// rule the runner compares by.
func same(produced, expected any) bool {
	if produced == nil && expected == nil {
		return true
	}
	one, oneIsNumber := value.AsNumber(produced)
	other, otherIsNumber := value.AsNumber(expected)
	if oneIsNumber && otherIsNumber {
		return one == other
	}
	return value.Text(produced) == value.Text(expected)
}

func TestEveryRowOfTheExpressionTable(t *testing.T) {
	corpus, err := Find()
	if err != nil {
		t.Fatal(err)
	}
	context, err := corpus.YAML("expressions/context.yaml")
	if err != nil {
		t.Fatal(err)
	}
	cases, err := corpus.YAML("expressions/cases.yaml")
	if err != nil {
		t.Fatal(err)
	}
	rows, _ := walk.List(cases, "cases")
	if len(rows) <= 100 {
		t.Fatalf("only %d rows", len(rows))
	}

	failures := []string{}
	used := map[string]bool{}
	for _, raw := range rows {
		row, ok := walk.AsMap(raw)
		if !ok {
			continue
		}
		template, isTemplate := row.Value("template").(string)
		expression, _ := row.Value("expr").(string)
		text := expression
		label := fmt.Sprintf("expression [%s]", text)
		if isTemplate {
			text = template
			label = fmt.Sprintf("template [%s]", text)
		}
		for _, name := range expr.Read(text, false).Functions {
			used[name] = true
		}
		// The table reads the corpus's context keys as roots (where.CorpusExtension).
		scope := expr.NewScope(context, where.CorpusComposite().Roots...)
		if stable, _ := row.Value("stable").(bool); stable {
			scope = scope.Stable()
		}
		var produced any
		var failure error
		if isTemplate {
			produced, failure = expr.Expand(text, scope)
		} else {
			produced, failure = expr.Evaluate(text, scope)
		}

		if code, refused := row.Value("code").(string); refused {
			switch {
			case failure == nil:
				failures = append(failures, fmt.Sprintf("%s produced %v; the table says %s", label, produced, code))
			default:
				held, ok := failure.(*expr.Error)
				if !ok || held.Code != code {
					failures = append(failures, fmt.Sprintf(
						"%s is refused with %v; the table says %s", label, failure, code))
				}
			}
			continue
		}
		if failure != nil {
			failures = append(failures, fmt.Sprintf(
				"%s is refused with %v; the table says it produces a value", label, failure))
			continue
		}
		if expected, stated := row.Value("type").(string); stated {
			if kind(produced) != expected {
				failures = append(failures, fmt.Sprintf(
					"%s has type %s; the table says %s", label, kind(produced), expected))
				continue
			}
		}
		if expected, stated := row.Get("value"); stated {
			if !same(produced, expected) {
				failures = append(failures, fmt.Sprintf(
					"%s is [%s]; the table says [%s]", label, value.Text(produced), value.Text(expected)))
			}
		}
		if expected, stated := row.Value("count").(int64); stated {
			count := int64(-1)
			if items, ok := produced.([]any); ok {
				count = int64(len(items))
			}
			if count != expected {
				failures = append(failures, fmt.Sprintf(
					"%s holds %d entries; the table says %d", label, count, expected))
			}
		}
		if expected, stated := row.Value("length").(int64); stated {
			length := int64(len([]rune(value.Text(produced))))
			if length != expected {
				failures = append(failures, fmt.Sprintf(
					"%s is %d characters; the table says %d", label, length, expected))
			}
		}
	}

	missing := []string{}
	for _, name := range expr.FunctionNames() {
		if !used[name] {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		t.Errorf("the table calls no: %s", strings.Join(missing, ", "))
	}
	t.Logf("%d of %d expression rows match", len(rows)-len(failures), len(rows))
	if len(failures) > 0 {
		t.Fatalf("%d of %d rows differ:\n%s", len(failures), len(rows), strings.Join(failures, "\n"))
	}
}
