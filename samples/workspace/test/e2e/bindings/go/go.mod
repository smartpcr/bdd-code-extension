// The sample workspace's Go binding: its shop actions (package actions), its
// extension (package workspace) and its suiterun (cmd/suiterun), built on the
// Go runtime of this repository by path.
module example.com/shop/bindings/go

go 1.24

require github.com/smartpcr/bdd-code-extension/runtimes/go v0.0.0

require (
	github.com/santhosh-tekuri/jsonschema/v6 v6.0.3 // indirect
	golang.org/x/text v0.14.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)

replace github.com/smartpcr/bdd-code-extension/runtimes/go => ../../../../../../runtimes/go
