// A consumer of the bdd-suite Go module (docs/packages, E3): the module by
// version, with no replace directive, its own extension and suiterun, and its
// suites as go test tests. run-e3.ps1 installs the module from the local file
// GOPROXY that scripts/local-feeds.ps1 fills; go.sum is written by that run.
module example.com/greeter

go 1.24

require github.com/smartpcr/bdd-code-extension/runtimes/go v0.7.4

tool github.com/smartpcr/bdd-code-extension/runtimes/go/cmd/suiterun
