// Package actions is the demo workspace's actions: its extension of the Go
// runtime. cmd/suiterun beside this folder builds the workspace's suiterun
// from the runtime and these registrations.
package actions

import (
	"fmt"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/actions"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
)

// Registrations is every action the workspace adds to the runtime.
var Registrations = []actions.Registration{
	{Name: "demo.greet", Handler: demoGreet},
	{Name: "demo.count", Handler: demoCount},
}

func demoGreet(request *actions.Request) (any, error) {
	out := model.NewMap()
	out.Set("greeting", fmt.Sprintf("Hello, %v", request.Step.Value("name")))
	return out, nil
}

func demoCount(request *actions.Request) (any, error) {
	to, _ := request.Step.Value("to").(int64)
	counted := []any{}
	for i := int64(1); i <= to; i++ {
		counted = append(counted, i)
	}
	out := model.NewMap()
	out.Set("counted", counted)
	return out, nil
}
