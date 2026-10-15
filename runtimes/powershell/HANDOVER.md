# Handover to os-context: the runner's lab half (D10)

`BddSuite/Runner.ps1` (`Invoke-BddSuite`) is the generic half of os-context's
`scripts/e2e/Invoke-LabTestSuite.ps1` at commit `7633e176`. This note lists
what of that script stayed with os-context, and what its wrapper must do so
that `Invoke-LabTestSuite.ps1` keeps working once it loads `BddSuite` from the
pinned submodule (stage S6.9). Nothing here has been run against os-context
yet; it is the checklist for that stage.

## What stayed with os-context

| Part | Where it was in `Invoke-LabTestSuite.ps1` | Why it is not generic |
| --- | --- | --- |
| Parameters `-ConfigPath`, `-ApiUrl`, `-LabId`, `-ConnectionFile`, `-JumpConnectionFile`, `-OperationEvidenceDirectory` | `param()` | Lab options. They become the os-context extension's `Options`. |
| Lab-Config and credentials | `Import-PowerShellDataFile $ConfigPath`, the `PSCredential` from `DomainAdminUser`/`LocalAdminPassword`, `$ctx.cred`, `$ctx.cfg`, `$ctx.secrets`, `cluster` from `ClusterName` | Product configuration. The extension's `Start`. |
| The rule "pass -ConfigPath or -ApiUrl" | before the run | A lab-run precondition. |
| Budgets: `$LIFECYCLE_BUDGET_SEC = 900`, `HCI_LIFECYCLE_BUDGET_SEC`, the parse-time lifecycle checks, `Get-LifecycleBudgetFailure` (with the stream trail) | top of the script, the suite loop, `Invoke-Step` | The lifecycle rule. The core now has only its 14400 s ceiling; the 900 s rule is the extension's `Rules`. The core's case-timeout message is "Case exceeded its Ns budget after X.Xs." with reason `timeout`. |
| `Get-LabRequirementFacts`, case and step `requires`, the `not-applicable` skip | `Get-RunRequirementFacts`, `Get-StepRequirementReasons`, the case loop | `requires` is os-context's suite-schema field. The core no longer reads it, nor propagates a meta use site's `requires` (`__useSiteRequires`). |
| `Assert-LifecycleFixtureStep` | the pre-run step check | Lifecycle fixture names. |
| Operation evidence: `Write-LifecycleOperationEvidence`, `operationEvidenceErrors` failing a case or a hook | case loop, suite hooks | Product evidence. |
| `Close-LifecycleStreams` after each case and the teardown | case `finally`, after teardown | Lifecycle event streams. |
| `Complete-LifecycleStage7Gate` (`LifecycleStage7Gate.psm1`) | after each case | Stage 7. |
| Scenario catalog lint: `Test-ScenarioCatalogInput`, `Test-ScenarioCatalogCorpus` (E4xx) under `-Lint` | after the suite lint | os-context's scenario catalog. |
| Result publishing: `New-LabSuiteRunDocument`, `Publish-LabSuiteRun`, the `[FILED] <runId>` line | after the report | The lab page. |
| `Protect-LifecycleTestText` | every printed line and report text | Redaction is now an extension hook (`Start` returns `Redact`). |
| `LifecycleTestSupport.psm1`, `LifecycleStream.psm1` loaded by fixed path in the step runspace | `StepExecution.psm1` | The step runspace loads what extensions name (`Modules`). |
| The `E214` shared-checks rule and the lifecycle ceiling in the lint | `SuiteLint.psm1` | Extension `Rules.Lint`. |
| `HCI_SUITE_PARAM_<NAME>`, `HCI_SUITE_RECORD_PATH` | `SuiteModel.psm1`, `SuiteLint.psm1`, `actions/Core.ps1` | The prefix is the extension's `EnvPrefix`; the core default is `BDD_SUITE_`. |
| Timings schema name `hci.lifecycle.timings.v1` | `-TimingFile` | The core writes `bdd.suite.timings.v1` with the same `cases` and `steps`. |
| Default `-Path test/e2e/suites/*.yml`, resolved against the repository | `param()`, `Resolve-SuitePaths` | `Invoke-BddSuite` needs `-Path` and resolves it against the working directory. |

## What the wrapper must do

1. **Load the runtime.** `Import-Module <submodule>/runtimes/powershell/BddSuite/BddSuite.psd1`.
   Delete os-context's copies of `SuiteModel`, `SuiteLint`, `StepExecution`,
   `Expression`, `Assertions`, `ReportCompare`, `actions/ActionRegistry.ps1`,
   `actions/Core.ps1`, `actions/Wait.ps1` and `Conformance.Tests.ps1`: the core
   actions now come from `BddSuite`, and a second registration of `core.*` or
   `wait` is refused.
2. **Write the os-context extension module** (one `Get-SuiteExtension`):
   * `Name = 'os-context'`, `EnvPrefix = 'HCI_SUITE_'`, so existing variables keep working.
   * `ActionPath = @('actions')`: the lab action files. `ActionRegistry.ps1`
     no longer dot-sources every file in its folder; the runtime loads exactly
     the files named.
   * `Modules`: `LifecycleTestSupport.psm1`, `LifecycleStream.psm1` and any
     other module the actions call.
   * `ContextKeys = @('cluster', 'target', 'labId', 'apiUrl')`.
   * `Options`: `configPath`, `apiUrl`, `labId`, `connectionFile`,
     `jumpConnectionFile`, `operationEvidenceDirectory`.
   * `Start`: read Lab-Config, build the credential, start the secrets list;
     return `Context` (`apiUrl`, `labId`, `cluster` from `ClusterName` when
     the suite defaults do not name one), `State` (credential, config, secrets,
     connection files, evidence directory) and `Redact` (`Protect-LifecycleTestText`
     over the secrets list, which actions may still add to).
   * `Rules.Lint`: the lifecycle rule exactly as the old core reported it
     (E205 on a `defaults.timeoutSec` at its key, on a case value outside 1 to
     900 at its value, and on a case with no `timeoutSec` at the case), and
     E214 from `$In.Imports` (the `shared-checks.yml` import and its pointer),
     `$In.Model.sharedChecks` and `Get-SuiteAllStepEntry`. The handed-over
     `lifecycle-*` and E214 corpus entries prove both.
   * `Rules.CaseLimitSec`: for a suite tagged `lifecycle`, the smaller of the
     declared limit and 900 (or `HCI_LIFECYCLE_BUDGET_SEC`, never more).
3. **Adapt the actions' context reads.** `$Ctx.cred`, `$Ctx.cfg`,
   `$Ctx.secrets`, `$Ctx.connectionFile`, `$Ctx.jumpConnectionFile` and
   `$Ctx.operationEvidenceDirectory` move to `$Ctx.state.<name>`.
   `$Ctx.cluster`, `$Ctx.target`, `$Ctx.apiUrl` and `$Ctx.labId` stay (context
   keys). Per-case fields an action writes on `$Ctx` (streams, stage 7
   completion) still work, because `$Ctx` is the case's own hashtable.
4. **Decide the per-case pieces the extension API has no part for.** The
   five parts of DEC-S03 have no per-case hook, so these need either an
   addition to the API in all five runtimes or a home in os-context: the
   `requires` skip (`not-applicable`) for cases and steps; a case-level
   `cluster:` or `target:` overriding the context key (the core reads only
   `Start`, then `defaults`); operation evidence phase events and failing a
   case on `operationEvidenceErrors`; closing lifecycle streams after each case
   and the teardown; stage 7 completion; the fixture-name pre-check.
5. **Keep the wrapper's command line.** `Invoke-LabTestSuite.ps1` keeps its
   parameters, resolves `-Path` against the repository root (default
   `test/e2e/suites/*.yml`), calls `Invoke-BddSuite` with
   `-Extension <os-context module> -Option @{ apiUrl = ...; labId = ...; ... }`
   and the generic parameters, prints `-Json` diagnostics itself, and
   `exit $outcome.ExitCode`. Passing `-SchemaRoot test/e2e/schema` explicitly
   avoids depending on the working directory.
6. **After the run:** with `-Lint`, add the scenario catalog lint (E4xx) to
   `$outcome.Diagnostics` and recompute the exit code; on a lab run, build and
   publish the run document from `$outcome.Suites` and the `-TimingFile`
   document (now `bdd.suite.timings.v1`), and print `[FILED] <runId>`.
7. **Tests that stay in os-context:** the os-context parts of
   `SuiteLint.Tests.ps1` (its catalog, its suites, the lifecycle and E214
   position rows) and `Invoke-LabTestSuite.Tests.ps1`, run through the
   wrapper; a corpus harness for the handed-over corpus entries, linted with
   the os-context extension.
