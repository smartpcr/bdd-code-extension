// The Go runtime of the BDD suite format: the library (public packages under
// suite/), the suiterun command line (cmd/suiterun) and an example extension
// (example/). A consumer builds its own suiterun from suite/suiterun.Main and
// its extensions.
module github.com/smartpcr/bdd-code-extension/runtimes/go

go 1.24

require (
	github.com/santhosh-tekuri/jsonschema/v6 v6.0.3
	golang.org/x/text v0.14.0
	gopkg.in/yaml.v3 v3.0.1
)
