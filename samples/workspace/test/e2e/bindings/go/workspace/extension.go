// Package workspace is the sample workspace's extension, Go binding: its shop
// actions, the context key store and the option --store that sets it.
package workspace

import (
	"example.com/shop/bindings/go/actions"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
)

// Shop is the workspace's extension.
var Shop = extension.Extension{
	Name:        "shop",
	Actions:     actions.Registrations,
	ContextKeys: []string{"store"},
	Options:     []extension.Option{{Flag: "--store", Description: "The store ${store} reads (main by default)."}},
	Start: func(options map[string]string) extension.RunState {
		store := options["--store"]
		if store == "" {
			store = "main"
		}
		return extension.RunState{Context: map[string]any{"store": store}, State: store}
	},
}
