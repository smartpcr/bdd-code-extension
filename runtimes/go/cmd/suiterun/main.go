// suiterun: the Go runtime's command line, with no extension.
//
// Everything it does lives in suite/suiterun, so a consumer's own suiterun is
// the same one line with its extensions added.
package main

import (
	"os"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/suiterun"
)

func main() {
	os.Exit(suiterun.Main(os.Args[1:], os.Stdout, os.Stderr))
}
