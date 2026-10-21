# Stage K7 evidence: pipeline and documentation

Plan: [docs/packages/implementation.md](../packages/implementation.md#stage-k7-pipeline-and-documentation-p1).
Recorded 2026-10-20 on Windows 11, on top of `93f8417` (K6), uncommitted.
**Status: built; run locally (pack-all, the four publish dry runs, E5 from
the packed feeds, actionlint with shellcheck); E10 not run** (it needs a
pull request, so a push: the user's call). Nothing published.

## What was built

| Where | What |
| --- | --- |
| `scripts/pack-all.ps1` (new) | **K7.1, D15, D16.** `local-feeds.ps1` for all five languages into `artifacts/feeds` (each package checked against `packaging/`, E1; the Go module zip too), then the seven files a release publishes into `artifacts/packages`: both C# `.nupkg` and `.snupkg`, the crate, the npm tarball, the module's `.nupkg`. Installs the TypeScript runtime's dependencies first when they are missing. |
| `scripts/publish/Publish-Package.ps1` (new) | **K7.4, DEC-P10.** One registry per call (`nuget`, `npm`, `crates`, `psgallery`): asks the registry whether the version exists and skips it if so; publishes with the credential its job gives (`NUGET_API_KEY` from `NuGet/login`, npm trusted publishing with `--provenance`, `CARGO_REGISTRY_TOKEN` from `rust-lang/crates-io-auth-action`, `PSGALLERY_API_KEY`); `-DryRun` publishes nothing: `npm publish --dry-run`, `cargo publish --dry-run`, and for nuget.org and the Gallery a report only. npm is named by URL (`--registry https://registry.npmjs.org/`), since a machine's npm configuration may name a mirror (this one does). A dry run that cannot reach a registry says so and goes on; a publish that cannot ask fails. |
| `.github/workflows/ci.yml` `packages` | **K7.2.** Runs `pack-all.ps1` (with .NET, Go, Node.js and powershell-yaml); keeps `packages` (the seven files) and `feeds` (the local feeds) as artifacts. |
| `.github/workflows/ci.yml` `consumers` | **K7.3.** A matrix of the five consumers, each with only its own toolchain, each from the `feeds` artifact with `-NoPack`: C# and PowerShell on Windows, Go, Rust and TypeScript on Linux, as before. The five provider jobs no longer pack and run their consumer; the Rust job's `cargo publish --dry-run` moved to the publish dry run. |
| `.github/workflows/ci.yml` `publish-dry-run` | **E10.** The four registries' dry runs, on a pull request or a push that is no release; no credential is given. |
| `.github/workflows/ci.yml` `publish` | **K7.4, D16.** The four registries for real, after every gate and the consumers, in the `release` environment, with `id-token: write`; only when the release is new **and** the repository variable `PUBLIC_REGISTRIES` is `true`. |
| `.github/workflows/ci.yml` `release`, `publish-github-packages` | **K7.5.** Both need the consumers and the workflow lint; the release needs `publish` too, and runs when every need passed or was skipped (`publish` is skipped while the public registries are off). With `PUBLIC_REGISTRIES` the notes gain a table of each package's registry page and the Go module's pkg.go.dev page. The Go tag is still made after the release, and so after the publishing. |
| `.github/workflows/ci.yml` `workflow` | **K7.6.** actionlint 1.7.7, which also parses the workflow and runs shellcheck on every `run:` script. |
| `README.md` | **K7.7.** "The runtime packages" under Install (each language, its package, how to install it today, its README); CI and "Releasing is automatic" describe packing, the consumers, the GitHub feed, the public registries behind `PUBLIC_REGISTRIES`, and `npm run set-version` in the release commands. |
| `CHANGELOG.md` | Unreleased: K7. 0.7.1: the PowerShell module, which shipped in 0.7.1 and was missing from its entry. |
| `docs/packages/migrating.md` (new) | **K7.8, D17.** From a copy to the package: what changes and why, per-language steps, dropping the patches, `bdd-suite:core`, the bundled generator, the check, the rollback; update2 as the worked example, from its actual state (its `fedc7b77c` already takes the C# packages at 0.7.0; the core copy, the generator's checkout link and `UPSTREAM.md` remain). |
| `docs/packages/implementation.md` | Operator setup: the `NUGET_USER` and `PUBLIC_REGISTRIES` repository variables. |

## Step by step

| Step | Status | Evidence |
| --- | --- | --- |
| K7.1 `pack-all.ps1`, `local-feeds.ps1` for all five | done | Run below. |
| K7.2 CI `packages` | built | actionlint; runs in CI on the next push. |
| K7.3 CI `consumers` | built | actionlint; E5 locally from the packed feeds; CI on the next push. |
| K7.4 Publish jobs, dry run, exists checks | built | The four dry runs locally. The real publish is off (`PUBLIC_REGISTRIES`) and cannot run before the operator setup; not run. |
| K7.5 The release needs them; notes; Go tag after | built | actionlint; the next release. |
| K7.6 actionlint | done | Clean, with shellcheck. |
| K7.7 READMEs, root Install, CHANGELOG | written | For the user's review (D17's "done when"). The runtime READMEs are K1 to K5's. |
| K7.8 `migrating.md` | written | For the user's review. |
| K7.9 E10 on a pull request | **open** | Needs a push. |

## Runs

| Run | Result |
| --- | --- |
| `pwsh -File scripts/pack-all.ps1` | Every package as listed (Bdd.Suite 3 files, Bdd.Suite.Testing 13, the Go zip 83, the crate 34, the tarball 69, the module 21), version 0.7.1; seven files in `artifacts/packages`, exit 0 |
| `Publish-Package.ps1 -DryRun` for `nuget`, `npm`, `crates`, `psgallery` | All exit 0. nuget.org answers that neither C# package exists ("would push"); `npm publish --dry-run` to `https://registry.npmjs.org/`, 69 files; `cargo publish --dry-run` packages, verifies and stops before the upload; the Gallery has no `BddSuite` ("would publish") |
| `samples/consumers/typescript/run-e5.ps1 -NoPack` (the one package K6 changed) | E5 passed, from the feeds `pack-all` wrote |
| actionlint 1.7.7 on `ci.yml`, with shellcheck 0.10.0 | no findings |

The other consumers (E2, E3, E4, E6) were not run again: their packages did
not change since they passed in K1 to K5; the `consumers` matrix runs all five
on the next push.

## Findings

* **`Publish-PSResource -WhatIf` publishes.** PSResourceGet 1.2.0 with
  `-NupkgPath` wrote `BddSuite.0.7.1.nupkg` into a file repository under
  `-WhatIf` (a probe repository in the scratch folder, deleted after). A dry
  run on that would publish to the Gallery, so the Gallery dry run calls
  nothing. E10 names `Publish-PSResource -WhatIf`; this is a deviation.
* **The names are free.** `suiterun` does not exist on crates.io, `BddSuite`
  not on the Gallery, `Bdd.Suite` and `Bdd.Suite.Testing` not on nuget.org;
  `@bdd-suite/runtime` could not be asked from this machine (npm goes through
  a mirror here), and the dry run in CI asks npmjs.com.
* **A version literal in the READMEs.** The runtime READMEs and the root
  README name 0.7.1 in their install lines; `set-version` does not move them.
  Left for the release that changes it; a candidate for the version check.

## Open

* **E10** on a pull request: the `packages`, `consumers`, `publish-dry-run`
  and `workflow` jobs in CI.
* **The user's review** of the READMEs and `migrating.md`.
* **The public registries** stay off until the operator setup is done and
  `PUBLIC_REGISTRIES` is set; then E11 (K8).
