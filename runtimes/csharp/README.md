# The C# runtime

## Install

```xml
<PackageReference Include="Smartpcr.BddSuite" Version="0.7.5" />          <!-- your extension and your suiterun -->
<PackageReference Include="Smartpcr.BddSuite.Testing" Version="0.7.5" />  <!-- your suites as tests -->
```

From nuget.org, with no setup. The package IDs are `Smartpcr.BddSuite` and
`Smartpcr.BddSuite.Testing` (nuget.org reserves `Bdd.Suite` for another
owner); the assemblies and namespaces inside are `Bdd.Suite` and
`Bdd.Suite.Testing`, so code is the same whichever feed it came from. Before
0.7.5, GitHub Packages had them as `Bdd.Suite` and `Bdd.Suite.Testing`.

Releases are also on this repository's GitHub Packages feed, and attached to
each GitHub release as `.nupkg` files. GitHub Packages asks for a token with
`read:packages` even to read, so add that feed with one:

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

`run --events <file>` writes step events as JSON lines while the run goes (each
step's id, file and line, timings, message, value and assertion operands), and
`--cancel-on-stdin-close` / `--cancel-file <path>` let a host stop a run with
its cleanup, afterEach and teardown still running (spec/events.md). In a
library, an `IRunObserver` that also implements `IStepObserver` gets the same
events; an action reads `ActionRequest.Ref`, calls `ActionRequest.Note(text)`
and attaches evidence with `ActionException.WithDetail(value)`.

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

Reference the package `Smartpcr.BddSuite.Testing` from an MSTest 4, NUnit 4 or xUnit v3 test
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
