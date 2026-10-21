# The C# runtime

## Install

```xml
<PackageReference Include="Bdd.Suite" Version="0.7.2" />          <!-- your extension and your suiterun -->
<PackageReference Include="Bdd.Suite.Testing" Version="0.7.2" />  <!-- your suites as tests -->
```

Releases are on this repository's GitHub Packages feed, and attached to each
GitHub release as `.nupkg` files. GitHub Packages asks for a token with
`read:packages` even to read, so add the feed with one:

```text
dotnet nuget add source https://nuget.pkg.github.com/smartpcr/index.json --name bdd-suite --username <you> --password <token with read:packages>
```

`Bdd.Suite` is the runtime and its extension API. A workspace adds its own
actions in a class that implements `IExtension`, and builds its own `suiterun`
from it in one line:

```csharp
// Program.cs of an Exe project whose AssemblyName is suiterun
return Bdd.Suite.Run.Runner.Run(args, Console.Out, Console.Error, new MyCompany.Actions.OrdersExtension());
```

Its catalog imports the core this package carries by name, with no copy of the
spec (`imports: [ "bdd-suite:core" ]`); the core's actions are cut to the
catalog's own `bindings` list. Besides `lint`, `run`, `list` and `actions`,
`run` and `list` take `--name glob[,glob]` (cases whose names match, with the tag
filter) and `run` takes `--progress` (live `StartGroup`/`EndGroup`/`Summary`
lines for long runs; spec/progress.md). An action that throws anything fails its
step; the run goes on.

Every bdd-suite package of one release carries the release's version, the VS
Code extension's, so keep both packages at the same one. A working consumer that
uses only these packages, under central package management, with its own
extension, `suiterun` and MSTest, NUnit and xUnit projects:
[samples/consumers/csharp](https://github.com/smartpcr/bdd-code-extension/tree/main/samples/consumers/csharp).

## What is here

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
