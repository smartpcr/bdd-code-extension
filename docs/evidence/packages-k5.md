# Stage K5 evidence: PowerShell

Plan: [docs/packages/implementation.md](../packages/implementation.md#stage-k5-powershell-p1).
Recorded 2026-10-20 on Windows 11, PowerShell 7.6.7, PSResourceGet 1.2.0,
Pester 5.7.1, powershell-yaml 0.4.12, on top of `3eafdd0` (the 0.7.1 release
commits). **Status: built; locally accepted (E1 and E6 for PowerShell, E7 and
E8 for PowerShell); in CI with the 0.7.1 release** (`f0357aa`, with the
Pester 6 fix `7abf7c8`, run 39517172892, green; `BddSuite.0.7.1.nupkg` is a
release asset).

## What was built

| Where | What |
| --- | --- |
| `BddSuite/Cli.ps1` | **D6.** `--name glob[,glob]` (repeatable) on `run` and `list`, `--progress` on `run`, in the usage; `--test-name` kept. |
| `BddSuite/Runner.ps1` | `Invoke-BddSuite -Name`, `-Progress`, `-Observer`; the observer sees each trace entry as `Add-SuiteTrace` records it, and each selected case start and finish; never in a dry run; the summary after the last file. The option check's loop variable was `$name`, which in PowerShell is `-Name` too: with any extension option the name filter became the option's name and skipped every case (caught by four existing tests); renamed. |
| `BddSuite/Progress.ps1` (new) | `Test-SuiteNameMatch` (`*` and `?` over the whole name, case-sensitive, brackets literal: not `-like`), `Set-BddSuiteProgressWriter` (standard output by default; returns the writer before), `New-BddSuiteProgressPrinter` (the `StartGroup`/step/`failure:`/`EndGroup`/`Summary` lines of spec/progress.md). |
| `BddSuite/Session.ps1` | A session selects by tags and names. |
| `BddSuite/SuiteLint.psm1`, `BddSuite/core.catalog.yaml` (new) | `bdd-suite:core` in `Read-SuiteCatalog`, read from the module's own copy of the core, with the cut to the importer's `bindings`. |
| Runspace worker | **K5.3.** Already turned every error record and exception into a failed step; `fixture.throw` (a `CryptographicException`, outside the old five) proves it through `worker-throws.yml`. |
| `BddSuite/BddSuite.psd1` | **D10.** Exports the three new functions; `CompatiblePSEditions = 'Core'`; `RequiredModules` powershell-yaml 0.4.12; `FileList` (20 files); `PSData` tags, `LicenseUri`, `ProjectUri`, `ReleaseNotes`. |
| `BddSuite/suiterun.ps1`, `BddSuite/Invoke-BddSuite.ps1`, `BddSuite/LICENSE` | The entries moved into the module folder (`git mv`), so an installed module carries them; thin forwarders at `runtimes/powershell/suiterun.ps1` and `Invoke-BddSuite.ps1`; the repository's license. |
| `tests/Packages.Tests.ps1` (new) | The folder equals `FileList`; the core and license copies equal the originals; the manifest's version and links; the forwarders run (`actions --json`, exit 2 without a verb, `-Lint`); the name glob; the observer leaves the trace as it is and hears nothing in a dry run; the progress writer and its hand-back (9 tests). |
| `tests/Conformance.Tests.ps1`, `tests/Session.Tests.ps1`, the corpus fixtures | Entries' `names`, `schemaRoot` and `progress` honoured; a `lists` block; `fixture.throw`; the session test passes the names and schema root to its whole-file run too. |
| `conformance/run-manifest.yaml` | Every `pendingIn: [powershell]` removed: no runtime is pending on any entry now. |
| `scripts/Test-PackageContents.ps1`, `packaging/BddSuite.files.txt` (new) | A module package: a NuGet package whose tags say `PSModule`, holding the listed 21 files (the module's 20 and `BddSuite.nuspec`), its `BddSuite.psd1` at the release version, a license link, a project link and `LICENSE`. |
| `scripts/local-feeds.ps1` | `-Language powershell`: `Publish-PSResource` of the module, and of the installed powershell-yaml it requires, into `artifacts/feeds/psresource` (a repository registered for the pack alone), checked. |
| `samples/consumers/powershell/` (new) | **D15.** The greeter in PowerShell: `suiterun.ps1` (`#Requires` BddSuite at the release version, then `Invoke-BddSuiteCli`), `Greeter/` (extension and actions), the catalog importing `bdd-suite:core`, the suites, `bddsuite.tests.yaml` (Pester), `run-e6.ps1`, a README. |
| `src/tools/versions.ts`, `test/unit/versions.test.ts` | A `ps-requires` kind: `set-version` moves the consumer's pin (15 files). The `psd1` rule now reads only the module's own `ModuleVersion` line: it also matched the new `RequiredModules` entry, and `set-version` would have stamped powershell-yaml's version. |
| `.github/workflows/ci.yml` | `packages` packs and checks the module and keeps it for the release; `providers-powershell` runs `run-e6.ps1` (E1, E6); the GitHub Packages push takes `Bdd.Suite*.nupkg` only, so the module goes to the release, not the NuGet feed; the release notes read the module's own version (the same `RequiredModules` collision) and say how to install the asset. |
| `README.md` | "Install" (a folder repository and `Install-PSResource`), the consumer's `suiterun.ps1`, `bdd-suite:core`, the new flags, the observer, the layout. |

## Step by step

| Step | Status | Evidence |
| --- | --- | --- |
| K5.1 `--name`, `--progress`; `--test-name` kept | done | Corpus `names*.yml`, `lists`; `Packages.Tests.ps1`. |
| K5.2 The observer and the progress printer | done | Corpus `progress.yml` against the transcript; `Packages.Tests.ps1`. |
| K5.3 The worker catches every error | done | Corpus `worker-throws.yml`. |
| K5.4 Core in the module; `bdd-suite:core` | done | Corpus `core-import` (execute and validate); `Packages.Tests.ps1`. |
| K5.5 Pester tests; the corpus | done | Runs below. |
| K5.6 Gallery metadata, `FileList`, entries in the module | done | `Packages.Tests.ps1`; the package check. |
| K5.7 A file PSResource repository; E1 (PowerShell) | done | Below. |
| K5.8 `samples/consumers/powershell`; E6 | done | 11 checks. |

## Runs

| Run | Result |
| --- | --- |
| `Invoke-Pester runtimes/powershell`, first run | 113 passed, 5 failed: four with an extension option (the `$name` collision above), and the session test's whole-file run without the entries' names |
| `Invoke-Pester` on the four files those were in, after the fixes | 108 passed |
| `Invoke-Pester tests/Packages.Tests.ps1` | 9 passed (after one fix to the test: `actions --json` prints names, not objects) |
| `Invoke-Pester runtimes/powershell`, everything | **127 passed, 0 failed** (93 s); the corpus: 1636 assertions, 42 validate, 20 execute, **0 pending** |
| `npm run check-versions`; `npm run test:unit` (extension, for `versions.ts`) | 15 files at 0.7.1; 251 passed, 100% coverage |
| `scripts/local-feeds.ps1 -Language powershell` | `BddSuite.0.7.1.nupkg: 21 files as listed, version 0.7.1, module manifest, LICENSE, license and project links`; `powershell-yaml.0.4.12.nupkg` beside it |
| `scripts/local-feeds.ps1 -Language csharp` (the check script changed) | both C# packages still as listed |
| `samples/consumers/powershell/run-e6.ps1 -NoPack` | **E6 passed**, 11 checks: the pin; no path into the repository; `Save-PSResource` installs BddSuite 0.7.1 and powershell-yaml from the repository into `artifacts/e6/modules`; `Import-Module BddSuite` by name is 0.7.1 from there; `lint` clean through `bdd-suite:core`; `list --name '*hello'`; `run --name --progress`; `generate` writes `Greeting` and `Loud`; Invoke-Pester: `says-hello` and `the-core-still-works` passed, `shouts-hello` skipped; all passed with `BDD_SUITE_ALLOW_GUARDED=1`; a full-name filter selects one |
| `samples/workspace/tests/powershell/generate.ps1 -Check` | 29 generated files up to date |
| `harness/corpus.mjs --provider pester`, `powershell/scenarios.mjs` | 16 corpus entries and 9 sample suites, 0 differ; scenarios E8, E9, E10, E12: 4 of 4 |
| `npm run install:local` | `asz.bdd-suite@0.7.1` installed into VS Code |

## Deviations from the plan

* **E6 installs with `Save-PSResource -Path`, not `Install-PSResource -Scope
  CurrentUser`.** `Install-PSResource` has no destination: it would install
  into the user's own module folder, which the scenario's cleanup could not
  remove safely. `Save-PSResource` resolves the same repository, version and
  dependencies into a folder of the run's own, which then leads
  `PSModulePath`; `Get-Module` proves the module came from there.
* **The module package names no README.** A PowerShell module's metadata is
  its manifest, which has a license and a project link, not a README; the
  check asks for those and the license file instead.

## Open

* **CI** for K5, including the module in `packages` and E6 in
  `providers-powershell`.
* **Publishing** is not part of K5. The module goes to the release as an asset;
  the Gallery waits for the public registries.
