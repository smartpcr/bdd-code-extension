// The assertion table, row by row.

package conformance

import (
	"fmt"
	"strings"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/assertion"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/value"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

func TestEveryRowOfTheAssertionTable(t *testing.T) {
	corpus, err := Find()
	if err != nil {
		t.Fatal(err)
	}
	cases, err := corpus.YAML("asserts/cases.yaml")
	if err != nil {
		t.Fatal(err)
	}
	rows, _ := walk.List(cases, "cases")
	if len(rows) <= 80 {
		t.Fatalf("only %d rows", len(rows))
	}

	failures := []string{}
	used := map[string]bool{}
	for _, raw := range rows {
		row, ok := walk.AsMap(raw)
		if !ok {
			continue
		}
		operator := walk.Text(row, "op")
		used[operator] = true
		actual := row.Value("actual")
		expected := row.Value("expected")
		present := true
		if stated, ok := row.Value("present").(bool); ok {
			present = stated
		}
		label := fmt.Sprintf("%s of [%s] against [%s]",
			operator, value.Text(actual), value.Text(expected))
		held, refused := assertion.Compare(operator, actual, expected, present)

		switch walk.Text(row, "result") {
		case "error":
			if refused == nil {
				failures = append(failures, fmt.Sprintf(
					"%s returned %v; the table says it cannot be compared at all", label, held))
				continue
			}
			if code, stated := row.Value("code").(string); stated && refused.Code != code {
				failures = append(failures, fmt.Sprintf(
					"%s is refused with [%v]; the table says %s", label, refused, code))
			}
		case "pass":
			switch {
			case refused != nil:
				failures = append(failures, fmt.Sprintf(
					"%s was refused with [%v]; the table says it passes", label, refused))
			case !held:
				failures = append(failures, fmt.Sprintf("%s is false; the table says it passes", label))
			}
		case "fail":
			switch {
			case refused != nil:
				failures = append(failures, fmt.Sprintf(
					"%s was refused with [%v]; the table says it fails", label, refused))
			case held:
				failures = append(failures, fmt.Sprintf("%s is true; the table says it fails", label))
			}
		default:
			failures = append(failures, fmt.Sprintf(
				"%s states result [%s], which is not pass, fail or error", label, walk.Text(row, "result")))
		}
	}

	missing := []string{}
	for _, name := range assertion.Operators() {
		if name != "script" && !used[name] {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		t.Errorf("the table has no row for: %s", strings.Join(missing, ", "))
	}
	t.Logf("%d of %d assertion rows match", len(rows)-len(failures), len(rows))
	if len(failures) > 0 {
		t.Fatalf("%d of %d rows differ:\n%s", len(failures), len(rows), strings.Join(failures, "\n"))
	}
}
