// The example workspace's own suiterun: the runtime's command line with the
// example extension, which is all a consumer's suiterun is.
package main

import (
	"os"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/example"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/suiterun"
)

func main() {
	os.Exit(suiterun.Main(os.Args[1:], os.Stdout, os.Stderr, example.Echo))
}
