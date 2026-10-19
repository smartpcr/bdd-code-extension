# Bdd.Suite.Testing: suites as MSTest tests

A C# test project that references this library and imports its targets gets
one test class per suite, generated at every build from the project's
`bddsuite.tests.yaml` (docs/test-providers; spec/test-plan.md). The tests run
the suite through the runtime's session (spec/session.md), so `dotnet test`
reports what `suiterun run` reports, case for case. MSTest 4 is the provider
built today; NUnit and xUnit follow (docs/test-providers, stage T3).

## Use it

```xml
<ItemGroup>
  <PackageReference Include="MSTest.TestFramework" Version="4.3.2" />
  <PackageReference Include="MSTest.TestAdapter" Version="4.3.2" />
  <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.4.0" />
  <ProjectReference Include="<runtimes/csharp>/Bdd.Suite.Testing/Bdd.Suite.Testing.csproj" />
  <ProjectReference Include="<your actions project>" />            <!-- the extension -->
</ItemGroup>
<Import Project="<runtimes/csharp>/Bdd.Suite.Testing/build/Bdd.Suite.Testing.targets" />
```

```yaml
# bddsuite.tests.yaml, beside the project
suites: [ "../suites/**/*.yml" ]
schemaRoot: ../schema
extensions: [ MyCompany.Actions.OrdersExtension ]   # a type with a parameterless constructor
contextKeys: [ store ]                              # the keys it adds, for linting
offlineActions: [ "core.*", "wait", "orders.read" ] # everything else is guarded
output: { namespace: MyCompany.Suites.Tests }
```

The provider comes from the package references (MSTest, NUnit, xunit.v3) unless
the config names one. Several configs may be listed as `BddSuiteConfig` items;
they share one run hook.

## What is generated

For each suite, `obj/<configuration>/<tfm>/BddSuite/<namespace>.<id>.g.cs`:

| Suite | MSTest |
| --- | --- |
| the suite | `[TestClass] Suite_<id>` |
| suite setup | `[ClassInitialize] Setup` |
| suite teardown | `[ClassCleanup] Teardown` |
| beforeEach, afterEach | `[TestInitialize] BeforeEach`, `[TestCleanup] AfterEach` |
| each case, each examples row | `[TestMethod(DisplayName = "<exact case name>")]` |
| tags | `[TestCategory]` |
| the run (extensions, options, trace) | `BddSuite.Run.g.cs`: `[AssemblyInitialize]`, `[AssemblyCleanup]` |

Nothing generated is committed; the build writes it again, rewriting only what
changed and deleting what no suite needs. A suite that does not lint clean
fails the build with its findings as build errors.

## Running

* **One case:** `dotnet test --filter "Name=rejects a bad quantity [qty\=0]"`
  (escape `= ( ) ! ~ & |` with a backslash). A tag: `--filter TestCategory=smoke`.
  A suite: `--filter "FullyQualifiedName~MyCompany.Suites.Tests.Suite_Orders."`.
* **Run inputs**, from `.runsettings` `TestRunParameters` first, the environment
  second: `BDD_SUITE_OPTION_<FLAG>` (`--api-url` is `BDD_SUITE_OPTION_API_URL`),
  `BDD_SUITE_TAGS`, `BDD_SUITE_DRY_RUN=1`, `BDD_SUITE_TRACE_FILE`,
  `BDD_SUITE_RECORD_PATH`. Suite parameters: `BDD_SUITE_PARAM_<NAME>` in the
  environment.
* **Guarded suites** (using an action `offlineActions` does not cover) report
  every case as skipped (inconclusive) with the reason, and run nothing, unless
  `BDD_SUITE_ALLOW_GUARDED=1`. `dotnet test` in CI cannot reach a lab by
  accident.
* **Parallelism** is safe at any MSTest setting: cases of one suite never
  overlap (the session's case lock); suites may run in parallel.

## How results show

* A case that fails or errors fails its test with the runtime's message; a
  skipped case (tag filter, guarded suite) is inconclusive (`NotExecuted` in
  TRX) with its reason; a failed suite setup fails every case with "Suite setup
  failed: ...".
* A failed afterEach fails that test's cleanup.
* **A failed suite teardown** fails the class cleanup. MSTest 4 shows it as its
  own failed row, `[<namespace>.Suite_<id> ClassCleanup]`, and keeps every case
  that passed passed (docs/evidence/test-providers-t0.md). That row reuses the
  class's last test's id in the TRX, so a tool reading TRX should match it by
  name. MSTest 3 attaches the failure to a passed test instead, which is why
  MSTest 4 is the minimum.
