// The validate corpus: every entry, byte for byte.
//
// A binding conforms when it finds the same problems at the same places. The
// message wording is not compared, because it is deliberately not part of the
// contract (spec/diagnostics.md). The corpus is linted with its own extension
// (where.CorpusExtension), which supplies the context keys its suites read.

package conformance

import (
	"fmt"
	"strings"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/validate"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/where"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/diag"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/schema"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/value"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

func TestEveryValidateEntry(t *testing.T) {
	corpus, err := Find()
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := corpus.Manifest()
	if err != nil {
		t.Fatal(err)
	}
	shipped, err := schema.Load(corpus.Schema())
	if err != nil {
		t.Fatal(err)
	}

	failures := []string{}
	checked := 0
	pending := []string{}
	for _, entry := range Entries(manifest, "validate") {
		suite := walk.Text(entry, "suite")
		// A pending entry is neither run nor counted as passed
		// (conformance/README.md).
		if PendingIn(entry, "go") {
			pending = append(pending, suite)
			continue
		}
		path := corpus.Path(suite)
		relative := diag.RelativePath(path, corpus.Root)

		binding := walk.Text(entry, "binding")
		if binding == "" {
			binding = "go"
		}
		bindingCheck, _ := entry.Value("bindingCheck").(bool)
		options := &validate.Options{Binding: binding, BindingCheck: bindingCheck, Extensions: where.CorpusComposite()}
		if given, ok := walk.AsMap(entry.Value("params")); ok {
			for _, name := range given.Keys() {
				options.Params = append(options.Params, [2]string{name, value.Text(given.Value(name))})
			}
		}

		// An entry may name an overlay: a small catalog merged over the shipped
		// one, so a rule the catalog drives can be proved without changing the
		// catalog every binding reads.
		effective := shipped
		if overlayName := walk.Text(entry, "catalogOverlay"); overlayName != "" {
			overlay, err := corpus.YAML(overlayName)
			if err != nil {
				t.Fatalf("%s: %v", overlayName, err)
			}
			effective, err = schema.WithOverlay(shipped, overlay)
			if err != nil {
				t.Fatalf("%s: %v", overlayName, err)
			}
		}

		produced, err := validate.File(path, relative, effective, options)
		if err != nil {
			t.Fatalf("%s: %v", suite, err)
		}
		expectation, err := corpus.JSON(walk.Text(entry, "expectation"))
		if err != nil {
			t.Fatalf("%s: %v", suite, err)
		}

		expected := []string{}
		rows, _ := walk.List(expectation, "diagnostics")
		for _, raw := range rows {
			row, ok := walk.AsMap(raw)
			if !ok {
				continue
			}
			expected = append(expected, fmt.Sprintf("%s@%s:%s [%s]",
				walk.Text(row, "code"),
				value.Text(row.Value("line")),
				value.Text(row.Value("column")),
				walk.Text(row, "severity")))
		}
		actual := []string{}
		for _, finding := range produced {
			actual = append(actual, fmt.Sprintf("%s@%d:%d [%s]",
				finding.Code, finding.Position.Line, finding.Position.Column, finding.Severity))
		}
		checked++
		if strings.Join(actual, " ") != strings.Join(expected, " ") {
			failures = append(failures, fmt.Sprintf("%s\n  produced: %s\n  expected: %s",
				suite, strings.Join(actual, " "), strings.Join(expected, " ")))
			continue
		}
		strict, _ := expectation.Value("strict").(bool)
		exit := 0
		if diag.Fails(produced, strict) {
			exit = 2
		}
		wanted := int64(0)
		if found, ok := expectation.Value("exitCode").(int64); ok {
			wanted = found
		}
		if int64(exit) != wanted {
			failures = append(failures, fmt.Sprintf("%s exits %d; the expectation says %d", suite, exit, wanted))
		}
	}

	t.Logf("%d of %d validate entries match; pending for go: %v", checked-len(failures), checked, pending)
	if checked < 40 {
		t.Fatalf("only %d entries were checked", checked)
	}
	if len(failures) > 0 {
		t.Fatalf("%d of %d entries differ:\n%s", len(failures), checked, strings.Join(failures, "\n"))
	}
}

// A compile-time reminder that the corpus reader hands back the model types the
// rest of the binding works in.
var _ *model.Map = model.NewMap()
