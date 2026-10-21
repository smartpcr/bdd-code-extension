# Stage K8 evidence: the first public release

Plan: [docs/packages/implementation.md](../packages/implementation.md#stage-k8-the-first-public-release-p1-remote).
Recorded 2026-10-20 on Windows 11, on top of `cc762ba` (the 0.7.2 release
commit), uncommitted. **Status: the tooling is built and checked locally; E11
not run.** It cannot run before the user's operator setup (K8.1) and their
go-ahead for a version (K8.2, K8.3): publishing to a public registry cannot
be undone, and the user chose, on 2026-10-20, this repository and its GitHub
Packages first, the public registries later. Nothing was published.

## What was built

| Where | What |
| --- | --- |
| `scripts/publish/Test-ReleaseSetup.ps1` (new) | **K8.1.** Reads, through `gh`, what of the operator setup GitHub can show: the `release` environment, its required reviewer and branch rule, the environment secret `PSGALLERY_API_KEY` (its name only), the repository variables `NUGET_USER` and `PUBLIC_REGISTRIES`; lists the registry-side settings only their owner can see (the npm org and trusted publisher, nuget.org's policy, crates.io's first publish and trusted publisher, the Gallery key's scope). Exit 1 while anything checkable is missing. Prints no secret. |
| `scripts/publish/Wait-Published.ps1` (new) | **K8.4.** Polls the address each installer reads until the registry serves the version, every 30 s for at most 60 minutes (E11): nuget.org's flat container (both C# packages), npm's registry document, crates.io's sparse index (`index.crates.io/su/it/suiterun`), the Gallery's package endpoint, proxy.golang.org's `.info`. |
| `samples/consumers/*/run-e*.ps1` | **K8.4.** `-FromRegistry`: nothing packed, no local feed. C#: a `nuget.config` naming only nuget.org, and the cached `Bdd.Suite`'s `.nupkg.metadata` must name it as its source. Go: `GOPROXY=https://proxy.golang.org` alone with the checksum database on; `go list -m` gives the version. Rust: no `[patch.crates-io]`; `cargo metadata` gives a crates.io source. TypeScript: `npm install @bdd-suite/runtime@<version>` from `https://registry.npmjs.org/`; the lock's `resolved` is npmjs.com's. PowerShell: `Save-PSResource` from the Gallery, with powershell-yaml. Every other check of each consumer is the same as from the local feeds. |
| `.github/workflows/ci.yml` `verify-registries` | **K8.4, E11's "When".** After the `release` job, only when the release went to the public registries (`PUBLIC_REGISTRIES`): a matrix of the five consumers on fresh runners whose checkout holds `samples/consumers` and `scripts/publish` only (no `runtimes/`), each waiting for its registry and then running with `-FromRegistry`. actionlint clean with shellcheck. |

The release notes' registry links (E11's "Then") and the publish jobs came in
K7.

## Step by step

| Step | Status | Evidence |
| --- | --- | --- |
| K8.1 The user completes the operator setup | **open (the user)** | `Test-ReleaseSetup.ps1` on 2026-10-20: all six checkable parts missing (below). |
| K8.2 Version bump; merged by the user | open | After K8.1; `npm version` and `npm run set-version`, as for 0.7.2. |
| K8.3 The user approves the `release` environment | open (the user) | |
| K8.4 The clean-install job | **built**, not run | actionlint; `Wait-Published.ps1` against released versions (below). |
| K8.5 Evidence; failures fixed forward | open | |

## Runs

| Run | Result |
| --- | --- |
| `Test-ReleaseSetup.ps1` | missing: the environment `release`, its required reviewer, its branch rule, the secret `PSGALLERY_API_KEY`, the variables `NUGET_USER` and `PUBLIC_REGISTRIES`; exit 1 |
| `Wait-Published.ps1 -Registry go` for 0.7.1 (released) | `served after 5 s` from proxy.golang.org: the Go module is public already, through the tag |
| `Wait-Published.ps1 -Registry psgallery` for 0.7.1, no wait | not served (404): BddSuite is not on the Gallery |
| The sparse-index parse, on `serde` | 316 versions read, `1.0.0` among them |
| actionlint 1.7.7 with shellcheck 0.10.0 | no findings |

The consumers' `-FromRegistry` paths need the packages on the registries,
so only the Go one can run before the first public release. After the 0.7.2
release (run 39524058263, green; tags `v0.7.2` and `runtimes/go/v0.7.2` at
`cc762ba`):

| Run | Result |
| --- | --- |
| `Wait-Published.ps1 -Registry go` for 0.7.2 | served after 4 s |
| `samples/consumers/go/run-e3.ps1 -FromRegistry` | **E3 passed from proxy.golang.org**, 13 checks: the module v0.7.2 from the public proxy, checked against the checksum database, no local feed; generate, lint, list, run, go test as from the local feed. E11's Go part, locally |

The same release pushed the four packages to GitHub Packages (its job log:
`Bdd.Suite`, `Bdd.Suite.Testing`, `BddSuite` pushed to the NuGet feed,
`+ @smartpcr/bdd-suite-runtime@0.7.2` to the npm registry).

## The first public release: 0.7.3 stopped, 0.7.4 released

The user did the setup (the `release` environment with themselves as
reviewer, `NUGET_USER` on that environment, `NPM_TOKEN` and `CRATES_IO_TOKEN`
for the first publishes, nuget.org's trusted publishing policy for
`Bdd.Suite` and `Bdd.Suite.Testing`, the repository variable
`PUBLIC_REGISTRIES` = `nuget,npm,crates`) and approved each publish.

| Run | What happened |
| --- | --- |
| 39528073290 (`f0ab360`, 0.7.3), attempts 1 and 2 | `PUBLIC_REGISTRIES` was not yet set (`registries=[]`): cancelled before the release, so 0.7.3 was not released to GitHub alone |
| attempt 3 | crates.io: `suiterun` 0.7.3 published (with `CRATES_IO_TOKEN`). npm: refused, `EOTP`, the account wants a one-time password and the token could not give one. nuget.org: both pushes answered **409 Conflict**, which `--skip-duplicate` reported as "already exists" and the script as "published" (fixed). The release was held back, as designed |
| attempt 4 (npm only, after a new token) | cancelled at the user's choice of a new version instead; 0.7.3 has no GitHub release |
| 39531837686 (`6c0b360`, **0.7.4**) | npm: `@bdd-suite/runtime` 0.7.4 published, with a provenance statement. crates.io: `suiterun` 0.7.4. GitHub Packages: all four. nuget.org: **409 Conflict again**, for a version that never existed: the conflict is not the version's. **Release v0.7.4** with its nine files; tags `v0.7.4` and `runtimes/go/v0.7.4` at `6c0b360` |

E11 for 0.7.4 (`verify-registries`):

| Consumer | Result |
| --- | --- |
| Go, from proxy.golang.org | passed (CI) |
| Rust, from crates.io | passed (CI) |
| TypeScript, from npm | failed in CI: the version document answered after 61 s, but the package document `npm install` reads answered only some 90 s later, so the install got E404. `Wait-Published.ps1` now waits for the package document. Then, locally, `run-e5.ps1 -FromRegistry`: **passed**, 12 checks, the lock resolving `https://registry.npmjs.org/@bdd-suite/runtime/-/runtime-0.7.4.tgz`, after fixing the lock read (its root package has the key "", which needs `-AsHashtable`) |
| C#, from nuget.org | cannot pass: nuget.org has no `Bdd.Suite` (search, the v2 feed and the flat container are empty; no look-alike ID exists). Open: the 409's reason, which `--skip-duplicate` hides; the user is to upload the package by hand to see nuget.org's message |

## nuget.org: the ID was reserved; renamed

nuget.org's Upload page, given `Bdd.Suite.0.7.4.nupkg` by the user: **"The
package ID is reserved. You can upload your package with a different package
ID."** Another owner holds a prefix reservation covering `Bdd.Suite`, so every
push was refused; nuget.org answers that with 409, which `dotnet nuget push
--skip-duplicate` reports as "already exists". `Smartpcr.BddSuite`,
`Smartpcr.BddSuite.Testing` (the user's choice; no package by those IDs, nor by
`BddSuite.Runtime` or `SuiteRun.Bdd`, existed) became the package IDs: the
`PackageId`s, the Testing package's `build/Smartpcr.BddSuite.Testing.targets`
(NuGet imports `build/<ID>.targets`), `packaging/`, the scripts, the C#
consumer, CI's release notes, the extension's version reader (both IDs), the
docs. Assemblies, namespaces and projects keep `Bdd.Suite`.

| Run | Result |
| --- | --- |
| `dotnet pack` with the new IDs at 0.7.4 | `Smartpcr.BddSuite.0.7.4.nupkg`: 3 files as listed; `Smartpcr.BddSuite.Testing.0.7.4.nupkg`: 13 files as listed, depending on `Smartpcr.BddSuite` 0.7.4 |
| `run-e2.ps1 -NoPack` on those packages | **E2 passed**, 15 checks: restored from the local feed; the renamed targets generate and run the tests under MSTest, NUnit and xUnit |
| The user uploads both on nuget.org | accepted |
| `npm run test:unit` | 259 passed, 100% |

0.7.5 is the first release CI publishes to nuget.org under the new IDs.

## 0.7.5: E11 on every public registry

Run 39535436620 (`96a49a3`). Attempt 1: npm and crates.io published; nuget.org
refused with **403** ("does not have permission to access the specified
package"): the trusted publishing policy still named `Bdd.Suite` and
`Bdd.Suite.Testing`, and the short-lived key covers only the policy's
packages. The user changed the policy's pattern to `smartpcr*`. Attempt 2
(the failed job re-run, approved): nuget.org answered `Created` for both
packages and their symbols; then the release and the Go tag.

| Registry | 0.7.5 | E11 |
| --- | --- | --- |
| nuget.org | `Smartpcr.BddSuite`, `Smartpcr.BddSuite.Testing` (served 211 s after the push, after nuget.org's validation) | CI: **passed**; and `run-e2.ps1 -FromRegistry` locally: passed, 15 checks, the cached package's source `https://api.nuget.org/v3/index.json`, MSTest, NUnit and xUnit |
| npm | `@bdd-suite/runtime`, with provenance | CI: **passed** (the fixed wait and lock read) |
| crates.io | `suiterun` | CI: **passed** |
| proxy.golang.org | the module, by the tag `runtimes/go/v0.7.5` | CI: **passed** |
| GitHub Packages | all four, the C# ones under the new IDs | |
| GitHub release v0.7.5 | nine files; notes link the registry pages | |

E11 holds for nuget.org, npm, crates.io and Go. The PowerShell Gallery is not
set up (no `PSGALLERY_API_KEY`; not in `PUBLIC_REGISTRIES`) and stays open.

**After the first publishes** (the user): add the trusted publisher on npm
(`@bdd-suite/runtime`) and crates.io (`suiterun`), then delete `NPM_TOKEN` and
`CRATES_IO_TOKEN` and revoke both tokens; optionally ask nuget.org to reserve
the prefix `Smartpcr.BddSuite`.

## What the user does, in order

1. The registry accounts, as section 6 of the plan lists: the npm org
   `bdd-suite` and its trusted publisher; nuget.org's trusted publishing
   policy; `suiterun` published once by hand to crates.io, then its trusted
   publisher; a Gallery API key.
2. On GitHub: the environment `release` with the user as required reviewer,
   limited to `main`; its secret `PSGALLERY_API_KEY`; the variable
   `NUGET_USER`; `Test-ReleaseSetup.ps1` until only `PUBLIC_REGISTRIES` is
   missing; then `PUBLIC_REGISTRIES`: `true`, or the registries set up so far (`nuget,npm,crates`).
3. A version bump pushed to `main`; approving the `release` environment when
   the run asks. The publish jobs, the GitHub release, the Go tag and
   `verify-registries` follow; this file records the run ID, each registry
   URL and the five consumers' results.
