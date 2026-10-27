// Package actions is the {{name}} actions, Go binding: one registration per
// action schema/actions.catalog.yaml declares, and its handler. Each handler
// reads its step's parameters (after substitution) from request.Step, does its
// work, and returns the capture shape the catalog declares; a failure is
// actions.Failed. The Suite Authoring extension's *Declare action* and
// *Implement in Go* add the next registration to Registrations and its
// handler at the end of this file.
package actions

import (
	"fmt"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/actions"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/model"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/walk"
)

// Registrations is every action this binding implements.
var Registrations = []actions.Registration{
	{Name: "{{action}}", Handler: {{actionCamel}}},
}

func {{actionCamel}}(request *actions.Request) (any, error) {
	text := walk.Text(request.Step, "text")
	if text == "" {
		return nil, actions.Failed(fmt.Sprintf("%s: text is required", request.Action))
	}
	out := model.NewMap()
	out.Set("text", text)
	return out, nil
}
