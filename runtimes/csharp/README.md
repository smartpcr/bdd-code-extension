# The C# runtime

`Bdd.Suite` (the suite model, lint, the run and the session, reports and the
extension API), `Bdd.Suite.Cli` (`suiterun`) and `Bdd.Suite.Testing` (the test
framework providers). It is held to the conformance corpus in
`../../conformance/` like every runtime.

## Run suites with your test framework

Reference `Bdd.Suite.Testing` from an MSTest 4, NUnit 4 or xUnit v3 test
project and put a `bddsuite.tests.yaml` beside it: every build generates one
test class per suite and one test per case and examples row
(`obj/<config>/BddSuite/*.g.cs`, never committed), so `dotnet test`, its
`--filter` and `--list-tests`, and the IDE's test explorer work on them. The
provider is detected from the project's package references.

```text
dotnet test                                                    # every suite
dotnet test --filter "FullyQualifiedName~Shop.Suite.Tests.Suite_Orders."
dotnet test --list-tests
dotnet test --logger trx                                       # one result per case and row
```

Guarded suites skip unless `BDD_SUITE_ALLOW_GUARDED=1`; options, parameters,
tags and the trace file come from `BDD_SUITE_*` variables (MSTest and NUnit
also read `.runsettings` `TestRunParameters`).
A failed suite teardown is a failed class cleanup row (MSTest) or a run-level
error (NUnit, xUnit), never a failed case.

The whole guide, with the config, the generated code and how each framework
shows results: [Bdd.Suite.Testing/README.md](Bdd.Suite.Testing/README.md).
Working projects: `../../samples/workspace/tests/csharp/{mstest,nunit,xunit}`.
The contract the generated code drives is `../../spec/session.md`.
