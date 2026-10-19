package conformance

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/cli"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/generate"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/run"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

// E3 for Go (docs/test-providers/design.md): every generate entry of the
// manifest, the plan printed by suiterun generate --plan compared with the
// expected plan as JSON (key order ignored), or the refusal's exit code and
// findings.
func TestE3EveryGenerateEntryOfTheManifest(t *testing.T) {
	corpus, err := Find()
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := corpus.Manifest()
	if err != nil {
		t.Fatal(err)
	}
	entries, _ := walk.List(manifest, "generate")
	checked := 0
	for _, raw := range entries {
		entry, _ := walk.AsMap(raw)
		if PendingIn(entry, "go") {
			continue
		}
		config := corpus.Path(walk.Text(entry, "config"))
		options, err := cli.Parse([]string{"generate", "--config", config, "--plan"})
		if err != nil {
			t.Fatal(err)
		}
		report := run.Generate(options)
		wantCode, _ := entry.Value("exitCode").(int64)
		if int64(report.Code) != wantCode {
			t.Errorf("%s exits %d, not %d: %s", config, report.Code, wantCode, report.Errors)
			continue
		}
		if expected := walk.Text(entry, "expected"); expected != "" {
			text, err := os.ReadFile(corpus.Path(expected))
			if err != nil {
				t.Fatal(err)
			}
			var want, got any
			if err := json.Unmarshal(text, &want); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(report.Out), &got); err != nil {
				t.Fatalf("%s: the plan is not JSON: %v", config, err)
			}
			if !reflect.DeepEqual(want, got) {
				t.Errorf("%s: the plan differs:\n%s", config, report.Out)
			}
		} else {
			loaded, err := generate.LoadConfig(config)
			if err != nil {
				t.Fatal(err)
			}
			plan, findings, err := generate.Build(loaded)
			if err != nil || plan != nil {
				t.Fatalf("%s: a plan from a suite that does not lint clean (%v)", config, err)
			}
			var gotFindings, wantFindings []string
			for _, one := range findings {
				gotFindings = append(gotFindings, fmt.Sprintf("%s:%d:%d %s", one.File, one.Position.Line, one.Position.Column, one.Code))
			}
			wanted, _ := walk.List(entry, "diagnostics")
			for _, raw := range wanted {
				one, _ := walk.AsMap(raw)
				wantFindings = append(wantFindings, fmt.Sprintf("%s:%v:%v %s", walk.Text(one, "file"), one.Value("line"), one.Value("column"), walk.Text(one, "code")))
			}
			if strings.Join(gotFindings, "\n") != strings.Join(wantFindings, "\n") {
				t.Errorf("%s: findings %v, not %v", config, gotFindings, wantFindings)
			}
		}
		checked++
	}
	if checked != 2 {
		t.Errorf("%d generate entries checked, not 2", checked)
	}
}
