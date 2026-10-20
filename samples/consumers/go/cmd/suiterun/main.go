// Command suiterun is the greeter's own suiterun: lint, run and list its suites
// with its extension.
package main

import (
	"os"

	"example.com/greeter/greeter"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/suiterun"
)

func main() {
	os.Exit(suiterun.Main(os.Args[1:], os.Stdout, os.Stderr, greeter.Extension))
}
