package suiterun

import (
	"bytes"
	"strings"
	"testing"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/internal/where"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
)

func main(arguments []string, extensions ...extension.Extension) (int, string, string) {
	var out, err bytes.Buffer
	code := Main(arguments, &out, &err, extensions...)
	return code, out.String(), err.String()
}

func TestAnUnreadableCommandLineIsRefusedWithTheUsage(t *testing.T) {
	code, out, err := main(nil)
	if code != 2 || out != "" || !strings.HasPrefix(err, "suiterun: a verb is needed.") || !strings.Contains(err, "suiterun actions [--json]") {
		t.Errorf("no arguments: %d %q %q", code, out, err)
	}
	region := extension.Extension{Name: "r", Options: []extension.Option{{Flag: "--region", Description: "The region."}}}
	_, _, err = main([]string{"run", "--path", "x.yml", "--nonsense"}, region)
	if !strings.Contains(err, "run does not take --nonsense") || !strings.Contains(err, "--region <value>  The region.") {
		t.Errorf("an unknown flag with an extension's option said %q", err)
	}
}

func TestExtensionsThatCannotBeComposedAreRefusedBeforeAnythingRuns(t *testing.T) {
	code, out, err := main([]string{"actions"},
		extension.Extension{Name: "a", ContextKeys: []string{"k"}}, extension.Extension{Name: "b", ContextKeys: []string{"k"}})
	if code != 2 || out != "" || err != "suiterun: Context key k is defined by both a and b.\n" {
		t.Errorf("it exited %d, printed %q and said %q", code, out, err)
	}
}

func TestAVerbsOutputAndErrorsGoToTheirStreams(t *testing.T) {
	code, out, _ := main([]string{"actions"})
	if code != 0 || out != "core.fail\ncore.noop\ncore.record\ncore.set\ncore.skip\ncore.sleep\nwait\n" {
		t.Errorf("actions: %d %q", code, out)
	}
	code, out, err := main([]string{"lint", "--schema-root", where.CorpusSchema(), "--path", "nosuchfile.yml"})
	if code != 2 || out != "" || !strings.HasPrefix(err, "suiterun: nosuchfile.yml names no file") {
		t.Errorf("lint of nothing: %d %q %q", code, out, err)
	}
}
