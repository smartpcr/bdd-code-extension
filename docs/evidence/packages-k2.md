# Stage K2 evidence: Go

Plan: [docs/packages/implementation.md](../packages/implementation.md#stage-k2-go-p1).
Recorded 2026-10-20 on Windows 11, Go 1.24 toolchain as installed, on top of
`3998301` with K0 to K2 uncommitted. **Status: built; locally accepted (E1
and E3 for Go, E7 and E8 for Go); CI not run** (nothing pushed; no tag made).

## What was built

| Where | What |
| --- | --- |
| `suite/cli/cli.go`, `suite/extension/extension.go` | **D3.** `--name glob[,glob]` and `--progress` in `cli.Options` (`Names`, `Progress`), the usage and the package comment; both among the core flags an extension may not take. |
| `internal/suite/suite.go`, `suite/exec/session.go`, `suite/run/run.go` | `suite.NameMatches` (the `--path` glob over the whole name); a session selects by the tag filter and the names; `list` applies both. |
| `suite/exec/exec.go`, `suite/trace/trace.go`, `suite/run/progress.go` (new) | `exec.Observer` (`CaseStarted`, `CaseFinished`, `Entry`) and `exec.Options.Names`/`Observer`; `Trace.OnAdded`, called outside the trace's lock and handing back the callback it replaces; `RunFile` attaches the observer for the file and puts the previous one back, never in a dry run, and reports only selected cases; `ProgressPrinter` and `run.ProgressWriter` (standard output, which Go does not buffer); the summary after the last file. A nil printer is never stored in the interface. |
| `suite/exec/exec.go` | The action's goroutine recovers any panic into that step's failure (reason `action`, "<action> panicked: <value>"). |
| `suite/schema/schema.go`, `suite/schema/core.catalog.yaml` (new) | `bdd-suite:core` with the cut; `CoreCatalogText`. Go embeds only files inside the module, so the module holds a **copy** of `spec/core.catalog.yaml`, and a test fails when it differs from the spec's. |
| `internal/where/where.go`, `samples/workspace/tests/go/corpusext/corpusext.go` | `fixture.throw`: a panic with a plain string, Go's most unusual failure. |
| `internal/conformance/*_test.go` | Entries' `names`, `schemaRoot` and `progress` honoured (progress captured from `run.ProgressWriter`, masked, compared; none without `--progress`); a new test for the `lists` entries; the session test 20 entries; a test that the module's `LICENSE` is the repository's. |
| `suite/run/progress_test.go` (new) | The unit tests C# has for the same features: flags and usage, globs, the trace callback, an observer that hears only selected cases and changes nothing (same trace JSON) and is detached afterwards, a dry run, every line kind of the printer, standard output by default, no progress without the flag and a summary over three files, a panic that fails its step while the run goes on, the core copy equal to the spec's, the cut, and the whole core when the importer lists no bindings. |
| `suite/run/run_test.go` | `actions` now lists `fixture.throw` too. |
| `conformance/run-manifest.yaml` | `go` removed from `pendingIn` of the K0 entries and the `lists`. |
| `cmd/suiterun/main.go` | **K2.6.** A package comment in godoc form (pkg.go.dev shows it), with the one-line consumer program and the tool use. |
| `runtimes/go/README.md` | "Install": `go get` and `go get -tool` at the release version, the tag form `runtimes/go/v<version>`, the one-line `suiterun`, `bdd-suite:core`, the new flags and their library form, the consumer sample by its GitHub URL. |
| `runtimes/go/LICENSE` (new) | A copy of the repository's: a module zip holds only the module's folder, and pkg.go.dev shows documentation only for a module whose zip holds a license. |
| `scripts/go-module-zip/` (new) | **K2.7.** A small module of its own that writes one version in the module proxy's layout (`list`, `.info`, `.mod`, `.zip`) with `golang.org/x/mod/zip`, the code the go command checks a module zip with. |
| `scripts/local-feeds.ps1` | `-Language go` writes `artifacts/feeds/goproxy` at `v<package.json version>` and checks the zip. |
| `scripts/Test-PackageContents.ps1`, `packaging/runtimes-go.files.txt` | A Go module zip: the `<module>@<version>/` prefix on every entry, the listed files (83), `go.mod` naming the module, a `LICENSE`, a `README`. Go module zips hold the module's `_test.go` files and test data; that is Go's convention, so they are listed. |
| `samples/consumers/go/` (new) | **K2.8.** The greeter in Go: `go.mod` requiring the module at the release version with `suiterun` as a tool and no `replace`; a catalog importing `bdd-suite:core`; the two suites; `greeter.Extension`; its `cmd/suiterun`; `tests/` generated and committed; `run-e3.ps1`; a README. No `go.sum`: see below. |
| `src/tools/versions.ts`, `test/unit/versions.test.ts` | Two more kinds stamped by `set-version`: the Go consumer's `require` line and the C# consumer's `BddSuiteVersion`, so a release moves the samples' pins with everything else (12 files). |
| `.github/workflows/ci.yml` | `providers-go` runs `run-e3.ps1` (E1 and E3). |

## Decisions taken in the stage

* **The core is a copy inside the module**, kept equal to the spec by a test,
  because `//go:embed` cannot reach outside the module.
* **E3 works in a scratch copy with its own module cache and the local feed
  first in `GOPROXY`.** `v0.6.10` of this module is already on
  proxy.golang.org, built from older code (the release job tagged it), so a
  shared cache or the public proxy could hand back that build. The checksum
  database lookup is skipped for this one module only (`GONOSUMDB`);
  dependencies are checked as usual. The script also proves the cached zip is
  byte-for-byte the feed's.
* **No `go.sum` in the consumer sample.** Its hash for the module would be the
  hash of a locally written zip of uncommitted code; the run writes `go.sum` in
  its copy, and a real project runs `go mod tidy` once.
* **The generated tests are committed and compared**, as Go convention has it:
  `run-e3.ps1 -Bootstrap` wrote them once; every later run fails if `go
  generate` writes anything else.

## Step by step

| Step | Status | Evidence |
| --- | --- | --- |
| K2.1 `--name`, `--progress`; `Names` and the observer | done | Unit tests; corpus. |
| K2.2 The progress printer | done | Unit test; corpus `progress.yml` against the transcript. |
| K2.3 Panics recovered into step failures | done | Unit test; corpus `worker-throws.yml` through `suiterun`, the session and `go test`. |
| K2.4 Embedded core; `bdd-suite:core` | done | Unit tests; corpus `core-import` validate and execute. |
| K2.5 Unit tests; `go test -race ./...`; the corpus | done | Runs below. |
| K2.6 Package docs and README | done | `cmd/suiterun` was the one package without a doc comment. |
| K2.7 Module zip and a file `GOPROXY`; E1 (Go) | done | 83 files as listed. |
| K2.8 `samples/consumers/go`; E3 | done | 13 checks. |

## Runs

| Run | Result |
| --- | --- |
| By hand, the built `suiterun`: `list --name` on `names.yml`, `run --name --progress` on `progress.yml`, `lint --binding-check --binding go` against `schema-core-import` | the three cases; the transcript's lines (after masking); E201 at 6:17 and 8:17 |
| `gofmt -l`, `go vet ./...` | clean |
| `go test -race ./...` (runtime) | every package ok |
| `go test -race -count=1 -v ./internal/conformance` | 0 of 62 entries pending for go; 20 of 20 execute, 42 of 42 validate, 2 list entries, 7 of 7 reports |
| `npm run test:unit` (extension, for `versions.ts`) | 251 passed, 100% coverage; `check-versions`: 12 files at 0.6.10 |
| `scripts/local-feeds.ps1 -Language go` | `v0.6.10.zip: 83 files as listed, version 0.6.10, go.mod, LICENSE, README` |
| `samples/consumers/go/run-e3.ps1` (packing first, comparing with the committed tests) | **E3 passed**, 13 checks: `require ... v0.6.10`, no `replace`; `go mod tidy` from the local feed; the cached zip is the feed's; `go generate` writes exactly the three committed files; its `suiterun` builds; `lint` clean through `bdd-suite:core`; `list --name '*hello'`; `run --name --progress`; `go test`: `says-hello` and `the-core-still-works` PASS, `shouts-hello` SKIP; all PASS with `BDD_SUITE_ALLOW_GUARDED=1`; `-run` selects one |
| `harness/corpus.mjs --provider go` | 16 corpus entries and 9 sample suites, 0 differ (`worker-throws`, `core-import` through `go test`; the four name and progress entries command line only) |
| `samples/workspace/tests/go/scenarios.mjs` | 5 of 5 |
| `go tool suiterun generate --check` in the sample's `shop` and `corpus` | 10 and 21 generated files up to date |

## Open

* **CI**, including the new E1/E3 step in `providers-go` (Linux: the script's
  file URL handles `/home/...` paths, untried until CI runs).
* Rust, TypeScript and PowerShell stay pending on the K0 entries until K3 to K5.
