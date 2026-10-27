// Command suiterun is this workspace's suiterun, Go binding: the runtime's
// command line with the {{name}} extension. The Suite Authoring extension
// builds and runs it (.vscode/settings.json, bddSuite.bindings.go).
package main

import (
	"os"

	"{{name}}/actions"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/suiterun"
)

func main() {
	os.Exit(suiterun.Main(os.Args[1:], os.Stdout, os.Stderr, actions.Extension))
}
