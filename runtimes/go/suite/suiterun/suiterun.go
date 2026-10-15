// Package suiterun is the command line as a function: what a consumer's own
// suiterun calls with its extensions.
//
//	package main
//
//	import (
//		"os"
//
//		"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/suiterun"
//	)
//
//	func main() { os.Exit(suiterun.Main(os.Args[1:], os.Stdout, os.Stderr, myExtension)) }
//
// Four verbs and three exit codes, shared with every runtime (DEC-Y14).
// Anything the tool cannot do at all, including extensions that cannot be
// composed, is 2 rather than 1.
package suiterun

import (
	"fmt"
	"io"

	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/cli"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/extension"
	"github.com/smartpcr/bdd-code-extension/runtimes/go/suite/run"
)

// Main runs one command line with the given extensions and gives back its
// exit code; it never calls os.Exit. Output goes to stdout and errors to
// stderr, each prefixed "suiterun: ", one write per stream.
func Main(arguments []string, stdout, stderr io.Writer, extensions ...extension.Extension) int {
	composite, err := extension.Compose(extensions...)
	if err != nil {
		fmt.Fprintf(stderr, "suiterun: %v\n", err)
		return cli.ExitRefused
	}
	options, err := cli.Parse(arguments, composite.Options...)
	if err != nil {
		fmt.Fprintf(stderr, "suiterun: %v\n", err)
		return cli.ExitRefused
	}
	report := run.Execute(options, composite)
	if report.Out != "" {
		fmt.Fprintln(stdout, report.Out)
	}
	if report.Errors != "" {
		fmt.Fprintf(stderr, "suiterun: %s\n", report.Errors)
	}
	return report.Code
}
