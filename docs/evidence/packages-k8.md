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
