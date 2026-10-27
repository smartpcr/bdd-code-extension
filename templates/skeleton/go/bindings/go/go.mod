// The Go binding of the {{name}} suites: the bdd-suite Go module at the release
// these suites are written against, and its suiterun as a tool (go tool
// suiterun generate writes the go test tests). Keep the Suite Authoring
// extension (asz.bdd-suite) at the same release. Run go mod tidy once to write
// go.sum; the build in .vscode/settings.json runs it too.
module {{name}}

go 1.24

require github.com/smartpcr/bdd-code-extension/runtimes/go v{{version}}

tool github.com/smartpcr/bdd-code-extension/runtimes/go/cmd/suiterun
