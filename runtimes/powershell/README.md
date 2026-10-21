# BddSuite: the PowerShell runtime

The PowerShell runtime of the BDD suite format (D7 of
[docs/self-contained/implementation.md](../../docs/self-contained/implementation.md)):
a module, `BddSuite`, with the suite model, the lint, step execution, the
expression language, the assertion operators, report comparison, the action
registry, the core actions (`core.*`, `wait`) and the generic runner,
`Invoke-BddSuite`. It knows no product: what a workspace adds comes from
extensions.

Requirements: PowerShell 7.2 or later (tested on 7.6.7), the
`powershell-yaml` module (tested with 0.4.12), and Pester 5 for the tests.

## Install

From this repository's GitHub Packages feed (the C# packages' feed; a token
with `read:packages`):

```powershell
$token = Get-Credential -UserName <your GitHub user> -Message 'a token with read:packages'
Register-PSResourceRepository -Name bdd-suite -Uri https://nuget.pkg.github.com/smartpcr/index.json -Trusted
Install-PSResource BddSuite -Version 0.7.4 -Repository bdd-suite, PSGallery -Credential $token
Import-Module BddSuite
```

Or from a release's file: save `BddSuite.<version>.nupkg` in a folder and
register that folder as the repository instead. The module is not on the
PowerShell Gallery yet; `powershell-yaml`, which it requires, comes from the
Gallery either way. It carries the release's version, the VS Code extension's,
so every runtime of one release agrees. `scripts/local-feeds.ps1 -Language
powershell` builds the same package from a checkout.

The package is the `BddSuite` folder, exactly the files its `FileList` names,
with `suiterun.ps1`, `Invoke-BddSuite.ps1`, the core catalog and the license
inside it. A workspace's own `suiterun.ps1` imports the module by name:

```powershell
#Requires -Modules @{ ModuleName = 'BddSuite'; RequiredVersion = '0.7.4' }
Import-Module BddSuite -DisableNameChecking
exit (Invoke-BddSuiteCli -Arguments $args -Extension @(Join-Path $PSScriptRoot 'My/My.psm1'))
```

Its catalog imports the core the module carries by name, with no copy of the
spec (`imports: [ "bdd-suite:core" ]`); the core's actions are cut to the
catalog's own `bindings` list. `run` and `list` take `--name glob[,glob]`
(`-Name`; cases whose names match, with the tag filter) and `run` takes
`--progress` (`-Progress`; live `StartGroup`/`EndGroup`/`Summary` lines for
long runs; spec/progress.md). An action that throws any error fails its step;
the run goes on. A library caller gives `Invoke-BddSuite -Observer` a
hashtable of `CaseStarted`, `CaseFinished` and `Entry` script blocks.

A working consumer that uses only the module, with its own extension,
`suiterun.ps1` and Pester tests:
[samples/consumers/powershell](https://github.com/smartpcr/bdd-code-extension/tree/main/samples/consumers/powershell).

## Layout

| Path | What it is |
| --- | --- |
| `BddSuite/BddSuite.psd1`, `BddSuite.psm1` | The module: loads the parts below and adds the extension API. |
| `BddSuite/Runner.ps1` | `Invoke-BddSuite`, the generic runner. |
| `BddSuite/Session.ps1` | The suite session a test framework drives (spec/session.md), the run context and the Pester glue; the runner runs every file through it. |
| `BddSuite/Generate.ps1` | `suiterun generate`: the test plan and the Pester tests (below). |
| `BddSuite/SuiteModel.psm1` | Meta-step expansion, imports, parameters, tables and outlines. |
| `BddSuite/SuiteLint.psm1` | The lint: structure (E1xx), semantics (E2xx), dataflow (E3xx); the catalog loader (`imports`). |
| `BddSuite/StepExecution.psm1` | One step, bounded by cancelling it in a second runspace; the action registry lives here. |
| `BddSuite/Expression.psm1`, `Assertions.psm1`, `ReportCompare.psm1` | The `${...}` language, the operator table, the canonical report form. |
| `BddSuite/actions/` | `ActionRegistry.ps1` (`Register-SuiteAction`), `Core.ps1`, `Wait.ps1`. |
| `BddSuite/Cli.ps1` | `Invoke-BddSuiteCli`, the `suiterun` command line every program has (below). |
| `BddSuite/Progress.ps1` | The name filter (`Test-SuiteNameMatch`), the progress printer and its writer. |
| `BddSuite/core.catalog.yaml`, `BddSuite/LICENSE` | Copies of `spec/core.catalog.yaml` (what `bdd-suite:core` reads) and the repository's license; a test keeps them equal. |
| `BddSuite/suiterun.ps1` | That command line as a script, with the core alone; a workspace's own `suiterun.ps1` adds its extensions. |
| `BddSuite/Invoke-BddSuite.ps1` | The older entry: `Invoke-BddSuite`'s own parameters as a script, which sets the exit code. |
| `suiterun.ps1`, `Invoke-BddSuite.ps1` | Forwarders to the two entries above, so the old paths keep working. |
| `tests/` | `BddSuite.Tests.ps1` (the runtime's own tests), `Cli.Tests.ps1` (the command line), `Session.Tests.ps1` (the session's rules and E1), `Generate.Tests.ps1` (the generator, golden files in `golden/pester`), `Packages.Tests.ps1` (the module as a package, the name filter, the observer) and `Conformance.Tests.ps1` (the corpus, with the generate entries). |
| `example/` | An example extension and its workspace (E3). |
| `HANDOVER.md` | What of os-context's runner stayed there, and what its wrapper must do (D10). |

## Running suites

```powershell
Import-Module ./runtimes/powershell/BddSuite/BddSuite.psd1
$outcome = Invoke-BddSuite -Path suites/*.yml -SchemaRoot schema -Extension my/My.Extension.psm1 -Option @{ region = 'eu' }
$outcome.ExitCode      # 0 passed, 1 a case failed, 2 the lint refused or the run could not start
```

or from a shell:

```text
pwsh -File runtimes/powershell/Invoke-BddSuite.ps1 -Path suites/*.yml -SchemaRoot schema `
    -Extension my/My.Extension.psm1 -Option region=eu
```

`Invoke-BddSuite` takes `-Path`, `-Tags`, `-TestName`, `-ResultsFile`,
`-ReportFormat NUnit3|JUnit`, `-DryRun`, `-Lint`, `-Strict`, `-Json`, `-Param
name=value`, `-TraceFile`, `-TimingFile`, `-StopFile`, `-SchemaRoot`,
`-ActionPath`, `-Extension`, `-Option`, `-Binding` and `-BindingCheck`. It
returns an object with `ExitCode`, `Diagnostics`, `Suites`, `Trace` and `Error`
and never exits the process; the script does. With `-Json` the script prints
the diagnostics as the one document `spec/diagnostic.schema.json` defines and
nothing else.

Every selected suite is linted before anything runs, and a run continues only
when the lint is clean: a suite that does not lint never reaches the system it
would act on. (The compiled runtimes run without linting first; this runner
keeps the gate it always had.)

**Where the schema is.** `-SchemaRoot` names the folder holding
`suite.schema.json` and `actions.catalog.yaml`, used as given with no search.
Without it, the workspace root is the nearest folder above the working
directory holding `test/e2e/schema` (the default workspace layout), and the
schema is there; with neither, the run refuses: *the workspace root cannot be
found from this directory (no test/e2e/schema above it); pass -SchemaRoot.*
Diagnostic paths are relative to the workspace root, or to the working
directory when there is none. `-Path` globs are relative to the working
directory.

**The catalog** may import others (DEC-S10): `imports` are read depth first in
the order listed, each relative to the file that names it; a name declared
twice is refused naming both files, and an import cycle is refused.

## Run suites with your test framework

`suiterun.ps1 generate` (or `Invoke-BddSuiteGenerate`) turns a project's suites
into Pester 5 tests: one `<Id>.Bdd.Tests.ps1` per suite, a `Describe` named
after it, and one `It` per case and examples row, tagged with the case's tags
(docs/test-providers, D14).

**1. A config**, `bddsuite.tests.yaml`, in the folder the tests go to
(spec/test-plan.md):

```yaml
suites: [ "../suites/*.yml" ]
schemaRoot: ../schema
provider: pester
extensions: [ ../My.Extension.psm1 ]           # module paths, relative to this file
contextKeys: [ store ]                         # what the extensions add, for linting before they load
offlineActions: [ "core.*", "wait", "shop.*" ] # a suite using anything else is guarded
```

**2. Generate:**

```text
pwsh -File runtimes/powershell/suiterun.ps1 generate --config tests/bddsuite.tests.yaml [--check] [--plan]
```

The files are written beside the config (or to `output.folder`, or `--out`)
and are meant to be committed: `--check` exits 1 naming each stale one, for
CI. A suite that does not lint clean stops generation with its findings
(exit 2). Only files the generator wrote are ever removed.

**3. Run** with BddSuite imported (the generated files import it by name only
when it is not loaded already):

```powershell
Import-Module ./runtimes/powershell/BddSuite/BddSuite.psd1
$config = New-PesterConfiguration
$config.Run.Path = 'tests'
$config.TestResult.Enabled = $true
$config.TestResult.OutputFormat = 'NUnit3'   # NUnit 2.5 shows a failed teardown as a success
Invoke-Pester -Configuration $config         # also -FullNameFilter 'orders.places an order', -TagFilter smoke
Reset-BddSuiteTestContext                    # the run context outlives one run otherwise
```

The run context, built once per `Invoke-Pester` run for each schema root and
extension list, comes from the environment under the extensions' prefix
(`BDD_SUITE_` by default): `BDD_SUITE_TAGS`, `BDD_SUITE_OPTION_<NAME>`
(`zoneName` is `BDD_SUITE_OPTION_ZONE_NAME`), `BDD_SUITE_PARAM_<NAME>`,
`BDD_SUITE_DRY_RUN=1`, `BDD_SUITE_TRACE_FILE` and `BDD_SUITE_RECORD_PATH`.
Guarded suites skip (`Set-ItResult -Skipped`) with "guarded suite: set
BDD_SUITE_ALLOW_GUARDED=1 to run it" unless that variable is `1`. A failed
suite teardown fails the `Describe`'s `AfterAll` (in NUnit3, the fixture with
`site="TearDown"`), never a case that passed.

The session the generated code drives (`Open-BddSuiteSession`,
`Invoke-BddSuiteSetup`, `Invoke-BddSuiteBeforeEach`, `Invoke-BddSuiteCase`,
`Invoke-BddSuiteAfterEach`, `Invoke-BddSuiteTeardown`, `New-BddSuiteRunContext`)
is exported for other hosts too; `Invoke-BddSuite` runs every file through it.
The contract is `../../spec/session.md`. A working project, with a driver
script: `../../samples/workspace/tests/powershell`.

## The suiterun command line

The same verbs, flags, outputs and exit codes as every program's `suiterun`
(`runtimes/typescript/src/cli.ts` and `run.ts`), so a tool calls the
PowerShell binding like any other (DEC-S11):

```text
pwsh -File runtimes/powershell/suiterun.ps1 lint    --path <glob> [--json] [--strict] [--binding-check] [--binding <name>]
pwsh -File runtimes/powershell/suiterun.ps1 run     --path <glob> [--tags a,b] [--name a*,b?] [--results f.xml] [--format nunit3|junit]
                                                    [--dry-run] [--param name=value] [--trace-file f.json] [--test-name <case>] [--progress]
pwsh -File runtimes/powershell/suiterun.ps1 list    --path <glob> [--tags a,b] [--name a*,b?] [--test-name <case>]
pwsh -File runtimes/powershell/suiterun.ps1 actions [--json]
```

`--schema-root <dir>` works with every verb, and each option an extension
declares is a flag, `--<name> <value>` (the example's `--region eu`).
`--test-name` is this runtime's addition: run (or list) exactly one case of
one suite file; an outline case selects all of its rows. Exit codes: 0 passed
(or a clean lint), 1 a case failed, 2 refused. A command line that cannot be
read prints `suiterun: <why>` and the usage on standard error; `lint --json`
prints the diagnostic array and nothing else; `list` prints `<file name>
<case>` per case; `run` prints `=== Suite: <file> ===`, one `  [<status>]
<case>` line per case and the verdict, and writes a report only with
`--results`. The run still lints first, so a suite the lint refuses is exit 2
with its findings and "Nothing was executed.".

A workspace's `suiterun.ps1` is the runtime's with its extensions:

```powershell
Import-Module <path to runtimes/powershell>/BddSuite/BddSuite.psd1 -DisableNameChecking
exit (Invoke-BddSuiteCli -Arguments $args -Extension "$PSScriptRoot/My.Extension.psm1")
```

`Invoke-BddSuiteCli` returns the exit code and never exits; `-Out` and
`-ErrorOut` take any `TextWriter` (the console by default), which is how
`tests/Cli.Tests.ps1` reads what it prints. `samples/workspace/scripts/e2e/suiterun.ps1`
is a complete one.

## Extensions

One model: **an extension is a PowerShell module that exports
`Get-SuiteExtension`**, which returns a hashtable. `Invoke-BddSuite -Extension
<path to .psm1 or .psd1>` imports it and calls that function. Every part is
optional:

| Key | What it adds |
| --- | --- |
| `Name` | Shown in errors and owns the extension's actions. Default: the module name. |
| `ActionPath` | Folders (or `.ps1` files) of action files, relative to the module's folder. Each file calls `Register-SuiteAction -Name <action> -Handler { param($Step, $Ctx) ... }`. |
| `Modules` | Further modules the step runspace imports before the action files load: helpers the actions call. |
| `ContextKeys` | Names readable as `${key}` in any expression and known to the dataflow lint. |
| `Options` | `@(@{ Name = 'region'; Description = '...' })`: the values `-Option @{ region = 'eu' }` (or `-Option region=eu` on the command line) may give. A camelCase name; its flag is the name in lower-case words (`zoneName` is `--zone-name`). |
| `Rules` | `@{ Lint = { param($In) <diagnostics> }; CaseLimitSec = { param($Suite, $DeclaredSec) <seconds> } }`. |
| `EnvPrefix` | The prefix of `PARAM_<NAME>` and `RECORD_PATH`. Default `BDD_SUITE_`. |
| `Start` | `{ param([hashtable]$Options) @{ Context = @{ key = value }; Redact = { param($Text) ... }; State = <anything> } }`, called once per run with the extension's own option values. |
| `Cases` | **PowerShell only.** `@{ SkipCase = { param($In) ... }; AfterCase = { param($In) ... }; ... }`: hooks the runner calls around each case and step ([Case hooks](#case-hooks-the-cases-part-powershell-only) below). |

What each part does at run time:

* **Actions.** Action files load twice: in the runner, which is how names and
  owners are known and duplicates refused, and in the step runspace, where the
  handlers actually run. The step runspace imports `BddSuite`, then every
  extension module and its `Modules`, then dot-sources every action file at
  its top level, so a helper function an action file defines is there when its
  handler runs. Nothing is loaded by a fixed path. `-ActionPath <folders>`
  adds action files with no other part, each folder owning its actions.
* **`$Ctx`.** A handler sees `capture`, `param`, `var`, `row`, `defaults`,
  `timeoutSec`, `recordPath`, one entry per context key, and `state`: what its
  own extension's `Start` returned as `State`. State is data; a scriptblock in
  it would run in the wrong runspace.
* **Context keys.** A key reads the value its extension's `Start` gave; failing
  that, the suite's `defaults` entry of that name (a field a workspace adds with
  a suite-schema extension); failing both, `''`. Expression roots are the
  core's (`capture`, `param`, `var`, `row`, `timeoutSec`, `defaults`) and every
  extension's keys, carried in each step's scope.
* **Rules.** `Lint` runs after the core's three passes, once per file. `$In`
  holds `Model` (the parsed suite), `Positions` (JSON pointer to YAML node),
  `File` (as findings report it), `FilePath`, `Library` (what the imports
  declare), `Imports` (every import the suite names, in order, with its full
  path and pointer) and `Schema`. It answers diagnostics made with
  `New-SuiteDiagnostic`. `CaseLimitSec` is the limit a case runs under given
  the one it declares; the smallest any extension allows applies.
* **Redaction.** Every `Redact` runs, in order, over each text a report carries
  (failure message, details, captured output) and each line the runner prints.

Composition refuses, before anything runs: *Action X is defined by both A and
B.*, *Context key K is defined by both A and B.*, *Option O is defined by both
A and B.*, *A sets the environment prefix P and B sets Q.* The core owns its
actions, its six roots, the names the runner keeps on `$Ctx` and
`Invoke-BddSuite`'s own parameter names. An option nobody declares is refused:
*Invoke-BddSuite does not take the option region: no extension of this run
declares it.* An action nobody registers fails its case: *Unknown action:
NAME. No extension of this runtime registers it.*

`Register-LabAction`, `Get-LabActionNames` and `Get-LabAction` are kept as
aliases, so an action file written against the old names loads unchanged.

The example in [example/](example) adds one of each part but `Cases`: `example.echo`, the
context key `region`, the option `region`, and a rule holding suites tagged
`slow` to 10 seconds per case (lint E205 and the run-time limit).

### Case hooks (the Cases part, PowerShell only)

`Cases` is an optional part of this runtime alone: the TypeScript, Go, Rust
and C# runtimes have no such part, and a suite whose meaning depends on it
runs only here. It exists for what a workspace does around each case and step
that the five portable parts cannot say: skip a case or a step the system
under test cannot meet, give a case a context value of its own, check a step
before anything runs, record the case's work, release what a case held open
and fail a case or a suite hook on evidence only the extension has.

Every hook is a scriptblock taking one hashtable, `$In`, and runs in the
runner's own session (not the step runspace). `$In` always holds `State` (the
hook's own extension's `State`, as `Start` returned it), `Suite` (the parsed
suite), `SuiteName` and `DryRun`; each hook adds what its point has:

| Hook | When | `$In` adds | Its answer |
| --- | --- | --- | --- |
| `SkipCase` | For each case the tag filter selected, before anything of it: before its context exists and before a failed suite setup is charged to it. | `Case`, `CaseName` | Nothing to run it; a sentence to skip it (trace reason `not-applicable`); or `@{ Message; Reason }`. The case is reported `skipped` with the sentence as its message, printed `[SKIP] <case> (<sentence>)`, has a `case` trace entry with the reason and no timings row. |
| `CaseContext` | When a case's context is built (after `param` and `row`, before `vars`, which may read it), and when the suite hooks' context is built (no `Case`). | `Ctx`, `Case` (or `$null`), `CaseName` | A hashtable; of it, only the extension's own context keys are taken, replacing what `Start` or `defaults` gave. The hook may also add fields of its own to `$In.Ctx`, which actions read as `$Ctx.<field>`. |
| `CheckStep` | For each step of the case and of its suite's hooks, right after the check that its action is registered, under `-DryRun` too. | `Step`, `Case`, `CaseName` | What it throws fails the case with that message, before anything runs. |
| `SkipStep` | Before every step the runner drives, in any phase (suite setup and teardown, beforeEach, case setup, steps, cleanup, afterEach), before the step's `ifCapture` guard. Not for the steps a `wait` polls. | `Step`, `Ctx`, `Phase`, `CaseName` | As `SkipCase`. The step is not run and the case goes on; the trace entry takes the reason, the timings row and the `[STEP]` event the sentence. |
| `WorkStarted` | When the case's own clock starts: after beforeEach and case setup passed, before its first step. | `Ctx`, `Case`, `CaseName` | None; what it throws fails the case. |
| `AfterStep` | After each of the case's own steps passed (not hook, cleanup or afterEach steps). | `Step`, `Ctx`, `Case`, `CaseName` | A sentence fails the case with it; the case's cleanup still runs. |
| `WorkFinished` | In the case's `finally`, when its clock stops, before cleanup. Also for a case that failed, ran under `-DryRun`, or was stopped. | `Ctx`, `Case`, `CaseName`, `Status`, `WorkSec` | None. |
| `CaseFinally` | In the case's `finally`, after its cleanup and afterEach, whatever the case did. | `Ctx`, `Case`, `CaseName`, `Status` | None. What it throws ends the run (exit 2), as any runner fault does. |
| `AfterCase` | After the case's `finally`, before its timings row, trace entry and result are recorded. Not for a case the run was stopped before. | `Ctx`, `Case`, `CaseName`, `Status` (as the hooks before it left it), `SuiteCtx` (the suite hooks' context, or `$null`) | Zero or more failures, each a sentence or `@{ Message; Reason; Line }`. Each fails the case: `Reason` (default `hook`) becomes its trace reason, `' ' + Message` is appended to its message, and `Line`, when given, is printed as `[FAIL] <case>: <Line>`. |
| `AfterSuiteHook` | After the suite setup's or teardown's steps all passed, inside its own verdict. | `Hook` (`setup` or `teardown`), `Ctx` | A sentence fails that hook with it: a refused setup errors every case (*Suite setup failed: ...*), a refused teardown is its own failed `teardown` entry. |
| `AfterTeardown` | After the suite teardown, passed or failed; only when the suite has a teardown that ran. | `Ctx` (the suite hooks' context) | None. |

Several extensions compose in `-Extension` order at every point. For
`SkipCase` and `SkipStep` the first that skips decides and later ones are not
asked; `AfterStep` and `AfterSuiteHook` stop at the first sentence; every
other hook is called for every extension. A hook's texts go through the
extensions' redaction like every other text the runner reports.

**Meta use sites.** Each step a meta use site stands for carries `__useSites`:
the use sites it was expanded through, innermost first, each a hashtable of
the use site's own fields except `meta`, `with` and `ifCapture`, which the core
consumes. The core interprets none of them; a `SkipStep` hook reads them, so a
field a workspace's suite-schema extension adds to a use site can decide every
step it stands for.

## Tests

```text
pwsh -NoProfile -Command "Invoke-Pester -Path runtimes/powershell"
pwsh -NoProfile -File runtimes/powershell/tests/Conformance.Tests.ps1 -RunHarness
```

The first runs everything: the runtime's tests, the corpus (as one Pester
test) and E3. The second runs the corpus alone and prints its counts. The
corpus is linted and run with its test extension
(`tests/CorpusExtension/BddSuite.Corpus.psm1`), which supplies the context keys
`conformance/` reads.

## The Test-Json defect, and the fix

On PowerShell 7.6.7, `Test-Json -Json $j -Schema $s -ErrorVariable e` returns
`False` for a suite that breaks the generated schema and leaves `$e` without
the failures under a nested location, so a lint built on it loses its
structural (E1xx) findings: `conformance/validate/typos.yml` lost `E101` at
4:5 and 8:5. `Invoke-SchemaValidation` (SuiteLint.psm1) therefore evaluates
with the library Test-Json wraps, JsonSchema.Net, directly
(`JsonSchema.FromText`, `Evaluate` with list output), and reads each failure's
message as the body and its instance location as the pointer, which is what
the Test-Json text "<message> at '<pointer>'" carried; every mapping
downstream (E101, E102, E103, E104, E105) is unchanged and the corpus holds
them. `Test-SuiteJson` is the small helper the other former `Test-Json` callers
use. `tests/BddSuite.Tests.ps1` ("the Test-Json defect and its fix") pins it.

## Where it came from

Copied from os-context `scripts/e2e` at commit `7633e176`: `SuiteModel.psm1`,
`SuiteLint.psm1`, `StepExecution.psm1`, `Expression.psm1`, `Assertions.psm1`,
`ReportCompare.psm1`, `actions/ActionRegistry.ps1`, `actions/Core.ps1`,
`actions/Wait.ps1`, `Conformance.Tests.ps1`, the generic half of
`Invoke-LabTestSuite.ps1` (now `BddSuite/Runner.ps1`), the JUnit writer from its
test support module, and the generic parts of `SuiteLint.Tests.ps1` (in
`tests/BddSuite.Tests.ps1`). What changed in the copy: the product's context
keys, a tag-based time ceiling, the shared-checks rule (E214), the fixed module
paths of the step runspace and the product's environment prefix moved out of the core into
extension parts; the registry refuses a name registered twice; the catalog
loader reads `imports`; the schema root is found as above. HANDOVER.md lists
what stayed behind.
