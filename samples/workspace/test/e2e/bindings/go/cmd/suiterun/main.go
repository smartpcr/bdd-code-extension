// The sample workspace's suiterun, Go binding: the runtime's command line
// with this workspace's extension.
//
//	go build -o suiterun.exe ./cmd/suiterun
package main

import (
	"os"

	"example.com/shop/bindings/go/workspace"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/suiterun"
)

func main() {
	os.Exit(suiterun.Main(os.Args[1:], os.Stdout, os.Stderr, workspace.Shop))
}
