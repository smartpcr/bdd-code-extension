// Package corpusext is what the conformance corpus needs from a runtime's
// extension (conformance/README.md): the context keys its suites read, with
// the values of expressions/context.yaml, fixture.append
// (execute/capture-isolation.yml), and fixture.throw, which panics with a plain
// string (execute/worker-throws.yml, spec/progress.md).
package corpusext

import (
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/actions"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/trace"
)

// Extension is the corpus's extension.
var Extension = extension.Extension{
	Name:        "the corpus",
	ContextKeys: []string{"cluster", "target", "labId", "apiUrl"},
	Actions: []actions.Registration{{Name: "fixture.append", Handler: func(request *actions.Request) (any, error) {
		list, ok := request.Step.Value("list").([]any)
		if !ok {
			return nil, &actions.Error{Message: "fixture.append: list must be a list", Reason: trace.Action}
		}
		return append(list, request.Step.Value("item")), nil
	}}, {Name: "fixture.throw", Handler: func(request *actions.Request) (any, error) {
		message, _ := request.Step.Value("message").(string)
		panic(message)
	}}},
	Start: func(map[string]string) extension.RunState {
		return extension.RunState{Context: map[string]any{
			"cluster": "HOST-CL01", "target": "HOST-N1", "labId": "lab1", "apiUrl": "http://api/api/v1",
		}}
	},
}
