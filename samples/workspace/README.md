# samples/workspace: a consumer workspace

A small but complete workspace built on this repository's five runtimes, in
the layout a new workspace gets (DEC-S11 of
[docs/self-contained/design.md](../../docs/self-contained/design.md)). It has
two jobs:

* **It shows a consumer the layout**: a catalog that imports the core, a
  suite-schema extension, suites, and the workspace's own actions in all five
  languages, each with its own `suiterun`.
* **It is the VS Code extension's integration fixture** (D8): navigation,
  completion, hover, lint parity, run parity across bindings, scaffolding and
  the live-lint latency test all run against it, with no other checkout.

The domain is a small shop. Every handler is deterministic and offline (no
network, no clock in its answers), and every language returns the same values,
so one suite gives one result in every binding.

## Layout

| Path | What it is |
| --- | --- |
| `test/e2e/schema/actions.catalog.yaml` | The catalog: imports `spec/core.catalog.yaml` (DEC-S10), declares the shop's actions and which bindings implement each. |
| `test/e2e/schema/shop.suite.json` | A suite-schema extension: adds the top-level field `owner`. |
| `test/e2e/schema/suite.schema.json`, `suite.schema.md` | Generated from the two files above and the core; committed. |
| `test/e2e/schema/Build-Schema.ps1` | Regenerates them (forwards to `spec/Build-Schema.ps1`); `-Check` verifies them. |
| `test/e2e/suites/` | The suites (below); `_lib/` holds an imported library, `flawed/` the deliberately broken files. |
| `scripts/e2e/actions/*.ps1` | PowerShell actions (`Register-SuiteAction`). |
| `scripts/e2e/Workspace.Extension.psm1`, `suiterun.ps1` | The PowerShell extension and `suiterun`. |
| `test/e2e/bindings/go/` | Go module: `actions/actions.go` (`var Registrations = []actions.Registration{...}`), `workspace/` (the extension), `cmd/suiterun`. |
| `test/e2e/bindings/rust/` | Rust crate: `src/actions.rs` (`pub fn actions() -> Vec<Action>`), `src/extension.rs`, `src/main.rs` (binary `suiterun`). |
| `test/e2e/bindings/dotnet/` | C#: `Suite.sln`, `Suite.Cli/Actions.cs` (`ActionRegistration` list), `ShopExtension.cs`, `Program.cs` (assembly `suiterun`). |
| `test/e2e/bindings/typescript/` | TypeScript: `src/actions.ts` (`action('x', x)`), `src/extension.ts`, `src/cli.ts`, `src/index.ts` (the runtime's library with the extension applied). |
| `tools/compare-bindings.mjs` | Runs the five `suiterun` programs side by side and fails when they disagree. |

Each language reaches its runtime in this repository by a relative path: Go by
a `replace` directive, Rust by a path dependency, C# by a project reference,
TypeScript by a `file:` dependency, PowerShell by `Import-Module`.

## The actions

| Action | powershell | csharp | go | rust | typescript | Why it is here |
| --- | --- | --- | --- | --- | --- | --- |
| `inventory.get` | yes | yes | yes | yes | yes | Implemented everywhere: navigation and references. |
| `shop.state` | yes | | | | | PowerShell only; its capture has an array of objects (`Items`). |
| `cart.add` | yes | yes | yes | yes | yes | |
| `order.place` | yes | yes | yes | | yes | Not implemented by rust. |
| `price.quote` | | yes | yes | yes | | Implemented by rust. |
| `stock.reserve` | | | yes | yes | yes | |
| `shipping.quote` | yes | yes | yes | yes | yes | `policy` has a default (`Standard`), declared on its own line. |
| `customer.lookup` | yes | yes | yes | yes | yes | |
| `audit.log` | yes | yes | yes | yes | yes | Registered everywhere, used by no suite. |
| `report.export` | (declared for csharp) | | | | | Declared, implemented by no binding: the one deliberate "declared, not registered". |

Every binding also has the core (`core.*`, `wait`), the context key `store`
(`${store}`, `main` unless given) and the option `--store <name>`.

## The suites

| Suite | Purpose | Lint |
| --- | --- | --- |
| `smoke.yml` | `shop.state` and `core.noop`: runs in PowerShell; any other binding gets E201 with `--binding-check`. | clean |
| `checkout.yml` | Imports `_lib/shop.yml` and uses its meta step `check-stock` with a parameter, a library parameter and variable. | clean |
| `waiting.yml` | `action: wait`, as a pause and as a poll of `inventory.get`. | clean |
| `shipping.yml` | `shipping.quote` with its defaulted `policy`, and an outline. | clean |
| `large.yml` | About 1000 lines, 20 cases, 120 steps: the live-lint latency test. | clean |
| `flawed/typos.yml` | An unknown key, a misspelled action, a misspelled assertion block (E101, E104, E101). | 3 errors |
| `flawed/dataflow.yml` | References that resolve to nothing (E301) and a read before the capture exists (E303). | 5 errors |
| `flawed/tables.yml` | Outline rows: ragged and repeated rows (E213), an unknown column, a row with no table (E301). | 4 errors |

Every binding gives the same findings, positions and messages for each of them.

## Building each binding

From `samples/workspace`, on a clean clone (Node.js 24, .NET 10, Go 1.24 or
later, Rust stable, PowerShell 7 with `powershell-yaml`):

```text
cd test/e2e/bindings/go         && go build -o suiterun.exe ./cmd/suiterun
cd test/e2e/bindings/rust       && cargo build            # target/debug/suiterun.exe
cd test/e2e/bindings/dotnet     && dotnet build Suite.sln # artifacts/bin/Suite.Cli/Debug/net10.0/suiterun.exe
cd test/e2e/bindings/typescript && npm ci && npm run build   # builds runtimes/typescript first; dist/cli.js
```

PowerShell needs no build. (On Linux or macOS drop `.exe`.)

## Running

Every binding takes the same command line, from `samples/workspace`:

```text
pwsh -File scripts/e2e/suiterun.ps1 lint --path test/e2e/suites/smoke.yml --json
test/e2e/bindings/go/suiterun.exe run --path test/e2e/suites/checkout.yml --trace-file out/trace.json
test/e2e/bindings/rust/target/debug/suiterun.exe lint --path test/e2e/suites/smoke.yml --binding-check --binding rust
test/e2e/bindings/dotnet/artifacts/bin/Suite.Cli/Debug/net10.0/suiterun.exe list --path test/e2e/suites/shipping.yml
node test/e2e/bindings/typescript/dist/cli.js actions --json
pwsh -File scripts/e2e/suiterun.ps1 run --path test/e2e/suites/checkout.yml --test-name a-standard-customer
```

The schema is found by walking up to `test/e2e/schema`; `--schema-root`
names it from anywhere else. After a catalog change:
`pwsh -File test/e2e/schema/Build-Schema.ps1` (and `-Check` in CI).

## Checking that the bindings agree

```text
node tools/compare-bindings.mjs --build
```

builds all four compiled bindings, then checks: each `actions --json` against
the catalog; `lint --json` for every suite, plain and with `--binding-check`
for each of the five targets; `list`; and `run` of every lint-clean suite,
where every binding that implements all of a suite's actions must give exit 0
and the same trace, and every other binding exit 1 with the same cases.
Without `--build` it uses what is already built.
