// Package greeter is the greeter's extension: what a consumer writes to add its
// own actions to the runtime. Its suiterun and its generated tests both load it.
package greeter

import (
	"strings"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/actions"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

// Extension is the greeter's actions.
var Extension = extension.Extension{
	Name: "greeter",
	Actions: []actions.Registration{
		{Name: "greet.say", Handler: func(request *actions.Request) (any, error) {
			return greeting("Hello, " + walk.Text(request.Step, "name") + "!"), nil
		}},
		{Name: "greet.shout", Handler: func(request *actions.Request) (any, error) {
			return greeting("HELLO, " + strings.ToUpper(walk.Text(request.Step, "name")) + "!"), nil
		}},
	},
}

func greeting(text string) *model.Map {
	out := model.NewMap()
	out.Set("text", text)
	return out
}
