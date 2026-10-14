# Stage B1 evidence

Recorded 2026-10-14. Plan: [implementation.md, stage B1](../implementation.md#stage-b1-navigation-and-hover-over-one-index).

## Identity

| What | Value |
| --- | --- |
| This repository | working tree on top of `d1f1acd`, not committed (the user commits) |
| `os-context` | `E:\work\os\os-context`, `HEAD` `1d0f0e40` with 28 locally modified files; the `oscontext` session ran against that working tree, the `worktree` session against a clean `git worktree` of `1d0f0e40` |
| VS Code under test | Insiders build `4c6cba1504`, downloaded by `@vscode/test-electron` 2.5.2 to `.vscode-test/` |
| `redhat.vscode-yaml` | latest from the Marketplace, installed into the test instance |
| Node.js | 24.16.0 (unit tests); the extension host's own Node for integration |
| OS | Windows 11 Enterprise 10.0.28000 |

## Unit gate

`OS_CONTEXT_ROOT=E:\work\os\os-context npm run test:unit`, exit 0:

```
tests 72, pass 72, fail 0, skipped 0
Statements   : 100% ( 1030/1030 )
Branches     : 100% ( 452/452 )
Functions    : 100% ( 82/82 )
Lines        : 100% ( 1030/1030 )
```

Scope: `src/core/**` and `src/config/**`. `src/features/**` and `src/extension.ts`
are not measured by `c8` (they run only in the extension host, plan 3.3); the
integration scenarios below are their proof.

Real-tree checks inside the unit run (`OS_CONTEXT_ROOT` set):

* B1.2-1: 100 actions, 24 listing every binding (`powershell, csharp, go, rust`), no errors.
* B1.3-1: 137 suite and library files, 2520 action steps, identical to the independent oracle.
* B1.3 item 6: `lifecycle-stage1.yml` (68,245 chars) parses in p50 9.3 ms, max 10.1 ms over 20 runs, far under `INDEX_DEBOUNCE_MS` (250).
* B1.4-1: each default recognizer finds exactly one site per declared action and no other names: PowerShell 100/100 (19 files), C# 24/24 (27 files), Go 24/24 (26 files), Rust 24/24 (26 files), TypeScript 0/0 (no source yet).

## Integration run

`OS_CONTEXT_ROOT=E:\work\os\os-context npm run test:integration`, exit 0, 19 passing:

```
=== session oscontext: E:\work\os\os-context
    log: Root: e:\work\os\os-context  Catalog: e:\work\os\os-context\test\e2e\schema\actions.catalog.yaml | Indexed 100 catalog actions, 137 suites and libraries, 172 registration sites in 1331 ms.
    ok B1.1-1 activates on the catalog, and the first log line names the root and the catalog
    ok B1.2-4 lifecycle.get names every binding its catalog entry lists, with links
    ok B1.2-4 / E-B2 hover half: cluster.state is PowerShell only
    137 files, 2520 action steps agree with the oracle
    ok B1.3-1 the initial scan indexes exactly the oracle suite files and their action steps
    ok lifecycle.get: the catalog entry and one registration in each of the four bindings
    ok cluster.state: exactly the catalog entry and PowerShell
    ok wait: the catalog, Wait.ps1, and the wait lines in Go exec.go, Rust actions.rs and C# Executor.cs
    ok E-B3 meta half: meta: select-lab in stage 0 resolves to _lib/lifecycle.yml
    ok a position that is not an action or a meta use has no definition from this extension
    lifecycle.get: 265 steps; lens "265 suite steps"
    ok B1.5-1/2/3 the Go site, the catalog entry and a step give the same list; the lens counts it; the oracle agrees
    ok B1.5-3 steps inside meta step definitions and libraries are included
    ok references on a meta definition list its uses across files
    ok a registration line for an action no suite uses says so
  13 passing
=== session empty: (a fresh empty temporary folder)
    ok B1.1-2 does not activate on its own, and registers no provider when activated
  1 passing
=== session worktree: (a fresh git worktree of 1d0f0e40, removed afterwards)
    hover showed the new parameter 100 ms after save; extension instance unchanged: true
    ok B1.7-1 / E-B8 hover half: a catalog save is visible in hover within 1 s, without a reload
    the new Go registration was a definition target 72 ms after save
    ok B1.7-2 a new registration line is a definition target within 1 s of save; a new suite file is indexed
    ok an unsaved edit to a suite is indexed after the debounce
    ok a deleted suite leaves the index
    ok a settings change rebuilds the layout and the index, reporting a wrong type
  5 passing
```

After the run, `git -C E:\work\os\os-context worktree list` shows no `bdd-suite-wt-*`
entry: the worktree was removed.

## Defects found while building, and the unstated decision behind each

| Found | Cause | Fix | The decision that was missing |
| --- | --- | --- | --- |
| PowerShell recognizers missed `lifecycle.observations`, `points`, `retry`, `rollback`, `reverify`, and "found" `lifecycle.$($entry.name)` | `lab-lifecycle.ps1` registers five actions in a loop with a name built at run time | names exclude `$`; a third recognizer reads the loop's table entries with a new `prefix: lifecycle.` | A recognizer may need to compose a name; `Recognizer.prefix` now exists |
| C# recognizer missed all 18 lifecycle entries, and matched `["$schema"]`, `["type"]`, `["properties"]`, `["$defs"]` | the handler group refused commas, which every lambda has; names were any string | handler is `.+?`; names must be dotted action names | Action names in C#/Rust are dotted; `wait` is found only by its own `names.Add`/`names.push` recognizer |
| Rust recognizer matched 28 assertion-operator arms (`"equals" =>` ...) | the dispatch-arm pattern took any string | names must be dotted | as above |
| Integration sessions started VS Code as plain Node | the developer's shell runs inside VS Code and inherits `ELECTRON_RUN_AS_NODE=1` | `runTest.ts` deletes it before launching | The harness owns the child's environment |
| Every integration run downloaded 338 MB | `@vscode/test-electron` 2.5.2 cannot read the versioned layout of current Insiders archives | reuse `.vscode-test/.../Code - Insiders.exe` when present (`BDD_VSCODE_REFRESH` forces a download) | The download is cached by the harness, not by the library |
| `executeCodeLensProvider` threw `Illegal argument` | VS Code requires the document to be open | the test opens it first | Tests open documents before asking for document-scoped results |
| Definition order assertions failed | VS Code orders merged definition results by document, not by provider order | tests compare as sets | The provider's own order (catalog first, then bindings) is visible only in our API, not after VS Code merges |
