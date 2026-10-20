# The Go runtime

The Go module `github.com/smartpcr/bdd-code-extension/runtimes/go`: the suite
model, lint, the run (`suite/exec`), reports and the `suiterun` command line
(`cmd/suiterun`), extensible by an outside package (`suite/extension`). It is
held to the conformance corpus in `../../conformance/` like every runtime.

## Run suites with your test framework

`suiterun generate` turns a project's suites into ordinary `go test` tests:
one `TestSuite_<Id>` per suite and one subtest per case and examples row, so
`go test`, its filters, `-json` and your editor's test runner work on them
(docs/test-providers, D8).

**1. A config**, `bddsuite.tests.yaml`, in the package that will hold the tests
(spec/test-plan.md, spec/tests.config.schema.json):

```yaml
suites: [ "../suites/*.yml" ]                 # globs relative to this file
schemaRoot: ../schema                         # where suite.schema.json and the catalog are
provider: go
extensions: [ example.com/shop/actions.Shop ] # import path and exported variable
contextKeys: [ store ]                        # what the extensions add, for linting before they load
offlineActions: [ "core.*", "wait", "shop.*" ] # a suite using anything else is guarded
output: { package: shop }
```

**2. Generate**, with the tool in your `go.mod`
(`go get -tool github.com/smartpcr/bdd-code-extension/runtimes/go/cmd/suiterun`)
and a `doc.go` in the package:

```go
//go:generate go tool suiterun generate --config bddsuite.tests.yaml
package shop
```

`go generate ./...` writes `bddsuite_main_bdd_test.go` (its `TestMain` calls
`suitetest.Main(m, <extensions>)`) and one `<Id>_bdd_test.go` per suite.
Commit them, as Go convention has it, and keep them current in CI with
`go tool suiterun generate --config bddsuite.tests.yaml --check`, which exits 1
naming each stale file. A suite that does not lint clean stops generation with
its findings (exit 2). `--plan` prints the test plan instead.

**3. Run** them like any test:

```text
go test ./...                                      # every suite
go test -run 'TestSuite_Orders/places_an_order' .  # one case: setup and teardown run once around it
go test -list .                                     # the suites
go test -json ./...                                 # one result per case and row
```

Go rewrites spaces in a subtest's name to `_`. The run context comes from the
environment, under the extensions' prefix (`BDD_SUITE_` by default):
`BDD_SUITE_TAGS` (cases it does not select are skipped with "tag filter"),
`BDD_SUITE_OPTION_<FLAG>` (an extension option, `--api-url` as `API_URL`),
`BDD_SUITE_PARAM_<NAME>`, `BDD_SUITE_DRY_RUN=1`, `BDD_SUITE_TRACE_FILE` (the
trace, written when the run ends) and `BDD_SUITE_RECORD_PATH`.

**Guarded suites** skip with "guarded suite: set BDD_SUITE_ALLOW_GUARDED=1 to
run it" unless that variable is `1`, so `go test` in CI never reaches a lab by
accident. **A failed suite teardown** fails the parent `TestSuite_<Id>`, never
a case that passed. Suites and their cases run one after another, as
`suiterun run` runs them (the generated tests do not call `t.Parallel`).

A working project: `../../samples/workspace/tests/go`. The contract the
generated code drives is `../../spec/session.md`.
