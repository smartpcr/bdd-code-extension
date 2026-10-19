// The sample workspace's suites and the conformance corpus as go test tests
// (docs/test-providers, D8). Package shop runs the sample suites with the
// sample's Go binding; package corpus runs the execute corpus. Their
// *_bdd_test.go files are generated (go generate ./...) and committed.
module example.com/shop/suitetests

go 1.24

require (
	example.com/shop/bindings/go v0.0.0-00010101000000-000000000000
	github.com/smartpcr/bdd-code-extension/runtimes/go v0.0.0
)

require (
	github.com/santhosh-tekuri/jsonschema/v6 v6.0.3 // indirect
	golang.org/x/text v0.14.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)

replace (
	example.com/shop/bindings/go => ../../test/e2e/bindings/go
	github.com/smartpcr/bdd-code-extension/runtimes/go => ../../../../runtimes/go
)

tool github.com/smartpcr/bdd-code-extension/runtimes/go/cmd/suiterun
