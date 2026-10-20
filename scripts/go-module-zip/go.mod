// The tool that writes a Go module version as the module proxy serves it, into
// a folder a file GOPROXY reads (docs/packages, D11). Its own module, so the
// runtime's go.mod gains no dependency.
module github.com/smartpcr/bdd-code-extension/scripts/go-module-zip

go 1.26.0

require golang.org/x/mod v0.41.0
