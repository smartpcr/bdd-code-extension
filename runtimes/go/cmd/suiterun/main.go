// Command suiterun is the Go runtime's command line, with no extension: lint,
// run, list and generate YAML suites.
//
// Everything it does lives in suite/suiterun, so a consumer's own suiterun is
// the same one line with its extensions added:
//
//	os.Exit(suiterun.Main(os.Args[1:], os.Stdout, os.Stderr, myactions.Extension))
//
// As a tool in a consumer's go.mod it generates the go test tests:
//
//	go get -tool github.com/smartpcr/bdd-code-extension/runtimes/go/cmd/suiterun
//	go tool suiterun generate --config bddsuite.tests.yaml
package main

import (
	"os"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/suiterun"
)

func main() {
	os.Exit(suiterun.Main(os.Args[1:], os.Stdout, os.Stderr))
}
