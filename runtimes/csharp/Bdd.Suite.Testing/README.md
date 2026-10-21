# Bdd.Suite.Testing: suites as MSTest, NUnit or xUnit tests

A C# test project that references this package gets one test class per suite, generated at every build from the project's
`bddsuite.tests.yaml` (docs/test-providers; spec/test-plan.md). The tests run
the suite through the runtime's session (spec/session.md), so `dotnet test`
reports what `suiterun run` reports, case for case. The providers are MSTest 4,
NUnit 4 and xUnit v3; the library itself depends on none of them.

## Use it

```xml
<ItemGroup>
  <PackageReference Include="Bdd.Suite.Testing" Version="0.7.4" />
  <!-- One framework: MSTest ... -->
  <PackageReference Include="MSTest.TestFramework" Version="4.3.2" />
  <PackageReference Include="MSTest.TestAdapter" Version="4.3.2" />
  <!-- ... or NUnit + NUnit3TestAdapter 6.x, or xunit.v3 + xunit.runner.visualstudio 3.x -->
  <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.11.0" />
  <ProjectReference Include="<your actions project>" />            <!-- the extension -->
</ItemGroup>
```

That is all: NuGet imports the package's build targets, which run the
generator the package carries (`tools/net10.0/suiterun.dll`, on the .NET 10
runtime the test project already needs) before every compile. Under central
package management, leave the versions out and set them in
`Directory.Packages.props`. Keep `Bdd.Suite.Testing` and `Bdd.Suite` at the
same version: every bdd-suite package of one release carries the release's
version (the VS Code extension's).

From a checkout of the bdd-code-extension repository instead, reference the
project and import the targets by path; the targets then build the generator
from `Bdd.Suite.Cli` beside them:

```xml
<ProjectReference Include="<runtimes/csharp>/Bdd.Suite.Testing/Bdd.Suite.Testing.csproj" />
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
they share one run hook. The sample projects in
`samples/workspace/tests/csharp/{mstest,nunit,xunit}` run the same configs
(`shared/`) under each framework.

## What is generated

For each suite, `obj/<configuration>/<tfm>/BddSuite/<namespace>.<id>.g.cs`:

| Suite | MSTest 4 | NUnit 4 | xUnit v3 |
| --- | --- | --- | --- |
| the suite | `[TestClass] Suite_<id>` | `[TestFixture] Suite_<id>` | `Suite_<id>`, with the class fixture `Suite_<id>_Fixture` |
| suite setup | `[ClassInitialize] Setup` | `[OneTimeSetUp] Setup` | the fixture's `InitializeAsync` |
| suite teardown | `[ClassCleanup] Teardown` | `[OneTimeTearDown] Teardown` | the fixture's `DisposeAsync` |
| beforeEach, afterEach | `[TestInitialize]`, `[TestCleanup]` | `[SetUp]`, `[TearDown]` | the test class's `IAsyncLifetime` (explicit) |
| each case, each examples row | `[TestMethod(DisplayName = "<name>")]` | `[TestCase(TestName = "<name>")]` on a parameterless method | `[Fact(DisplayName = "<name>")]` |
| tags | `[TestCategory]` | `[Category]` | `[Trait("Category", ...)]` |
| the run (extensions, options, trace) | `[AssemblyInitialize]`, `[AssemblyCleanup]` | a `[SetUpFixture]` in the global namespace | an assembly fixture |

`BddSuite.Run.g.cs` holds the run hook and the framework's verdicts. Nothing
generated is committed; the build writes it again, rewriting only what changed
and deleting what no suite needs. A suite that does not lint clean fails the
build with its findings as build errors.

## Running

| | MSTest | NUnit | xUnit |
| --- | --- | --- | --- |
| one case | `Name=rejects a bad quantity [qty\=0]` (escape `= ( ) ! ~ & \|`) | `FullyQualifiedName=<namespace>.Suite_<id>.<method>`: NUnit's `Name` filter breaks on a space | `FullyQualifiedName=<namespace>.Suite_<id>.<method>`, or `DisplayName=` with the same escaping as MSTest |
| a tag | `TestCategory=smoke` | `TestCategory=smoke` | `Category=smoke` |
| a suite | `FullyQualifiedName~<namespace>.Suite_<id>.` | the same | the same |

xUnit and the VSTest runner report zero tests and exit 0 when a filter matches
nothing; check the count.

* **Run inputs:** `BDD_SUITE_OPTION_<FLAG>` (`--api-url` is
  `BDD_SUITE_OPTION_API_URL`), `BDD_SUITE_TAGS`, `BDD_SUITE_DRY_RUN=1`,
  `BDD_SUITE_TRACE_FILE`, `BDD_SUITE_RECORD_PATH`, suite parameters as
  `BDD_SUITE_PARAM_<NAME>`. MSTest and NUnit also take them from `.runsettings`
  `TestRunParameters`, which win over the environment; xUnit hands test code no
  run settings, so it reads the environment only.
* **Guarded suites** (using an action `offlineActions` does not cover) report
  every case as skipped with the reason, and run nothing, unless
  `BDD_SUITE_ALLOW_GUARDED=1`. `dotnet test` in CI cannot reach a lab by
  accident.
* **Parallelism** is safe at any setting: cases of one suite never overlap (the
  session's case lock); suites may run in parallel. The frameworks also choose
  the order of a suite's cases (NUnit and xUnit do not keep file order), which
  the suite rules allow: each case starts from its own copy of the setup's
  captures.

## How results show

* A case that fails or errors fails its test with the runtime's message; a
  skipped case (tag filter, guarded suite) is `NotExecuted` in TRX with its
  reason (MSTest inconclusive, NUnit ignored, xUnit skipped); a failed suite
  setup fails every case with "Suite setup failed: ...".
* A failed afterEach fails that test's cleanup.
* **A failed suite teardown** fails the run and never turns a passed case into a
  failed one (docs/evidence/test-providers-t0.md):
  * **MSTest 4** shows it as its own failed row,
    `[<namespace>.Suite_<id> ClassCleanup]`, which reuses the class's last
    test's id in the TRX, so match it by name. MSTest 3 attaches it to a passed
    test instead, which is why MSTest 4 is the minimum.
  * **NUnit 4** reports it as a run-level error (TRX `RunInfo`, "TearDown failed
    for test fixture ..."); its console summary still says "Failed: 0", so read
    the exit code or the RunInfo.
  * **xUnit v3** reports it as a run-level error
    ("[Test Class Cleanup Failure (...)]").
