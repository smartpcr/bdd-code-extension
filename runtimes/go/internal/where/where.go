// Package where is where the tests find the corpus and its schema, and the
// extension the corpus is run with.
//
// The corpus lives at this repository's root (conformance/), with its own
// catalog and schema (conformance/schema); this runtime is runtimes/go, so
// both are found by walking up from the working directory to the folder that
// holds spec/core.catalog.yaml and conformance/run-manifest.yaml. Only tests
// use this package.
package where

import (
	"os"
	"path/filepath"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/actions"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/trace"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

// Repo is this repository's root. It panics when the tests are run from
// outside the repository, which no test can recover from.
func Repo() string {
	working, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	here, err := filepath.Abs(working)
	if err != nil {
		panic(err)
	}
	for {
		if isFile(filepath.Join(here, "spec", "core.catalog.yaml")) && isFile(filepath.Join(here, "conformance", "run-manifest.yaml")) {
			return here
		}
		parent := filepath.Dir(here)
		if parent == here {
			panic("the repository root (spec/core.catalog.yaml and conformance/run-manifest.yaml) is not above " + working)
		}
		here = parent
	}
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// Corpus is the conformance corpus.
func Corpus() string { return filepath.Join(Repo(), "conformance") }

// CorpusSchema is the corpus's schema root (run-manifest.yaml's schemaRoot).
func CorpusSchema() string { return filepath.Join(Corpus(), "schema") }

// CoreCatalog is the core catalog every runtime implements exactly.
func CoreCatalog() string { return filepath.Join(Repo(), "spec", "core.catalog.yaml") }

// CorpusExtension is the corpus's context keys (conformance/README.md): the
// core defines none beyond timeoutSec and defaults, so the corpus declares the
// ones its suites and expression table read, with the values of
// expressions/context.yaml. These names are the corpus's own, not the core's.
// It also implements fixture.append (execute/capture-isolation.yml): it changes
// the list it is given in place, as an extension action may, so a case that
// shared that list with the suite bag would show it; and fixture.throw
// (execute/worker-throws.yml), which panics with a plain string, Go's most
// unusual failure, so only a worker that recovers turns it into a failed step
// (spec/progress.md).
var CorpusExtension = extension.Extension{
	Name:        "the corpus",
	ContextKeys: []string{"cluster", "target", "labId", "apiUrl"},
	Actions: []actions.Registration{{Name: "fixture.append", Handler: func(request *actions.Request) (any, error) {
		list, ok := request.Step.Value("list").([]any)
		if !ok {
			return nil, &actions.Error{Message: "fixture.append: list must be a list", Reason: trace.Action}
		}
		// A Go slice cannot grow where its other holders see it, so this is
		// append; a shared map is how Go would leak, which the session tests
		// prove instead (exec/session_test.go).
		return append(list, request.Step.Value("item")), nil
	}}, {Name: "fixture.throw", Handler: func(request *actions.Request) (any, error) {
		panic(walk.Text(request.Step, "message"))
	}}},
	Start: func(map[string]string) extension.RunState {
		return extension.RunState{Context: map[string]any{
			"cluster": "HOST-CL01", "target": "HOST-N1", "labId": "lab1", "apiUrl": "http://api/api/v1",
		}}
	},
}

// CorpusComposite is the core and the corpus extension, composed.
func CorpusComposite() *extension.Composite {
	composite, err := extension.Compose(CorpusExtension)
	if err != nil {
		panic(err)
	}
	return composite
}
