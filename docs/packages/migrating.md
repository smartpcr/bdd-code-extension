# From a copy of a runtime to its package

For engineers who keep a repository that runs BDD suites on a copy of one of
this repository's runtimes (`runtimes/<language>`), a path import of
`spec/core.catalog.yaml`, or a checkout of this repository kept only to run
the schema generator. After the move the repository holds only what is its
own (its catalog, its extension, its suites) and takes the rest by version.
update2 is the worked example at the end.

Design: [design.md](design.md) (the outcomes O1, O3, O4 and O6).

## What changes, and why

| Today | After | Why it is better |
| --- | --- | --- |
| A copy of `runtimes/<language>`, with local patches | A package reference at a version | A refresh is a version bump, and the code you run is the code the conformance corpus proves |
| Local patches for `--name`, `--progress`, or a worker that survives any exception | Nothing: every runtime has them (DEC-P05, DEC-P06) | The patches and their tests go away |
| `imports: [ ../../path/to/spec/core.catalog.yaml ]`, or a hand-narrowed copy of it | `imports: [ bdd-suite:core ]` | The core is the one your runtime package carries, of its own version; each core action's `bindings` is cut to your catalog's `bindings` list for you |
| A checkout (or junction) of this repository to run `spec/Build-Schema.ps1` | The VS Code extension's own generator, its default `bddSuite.schemaGenerator` | Nothing outside your repository is needed |
| A TypeScript binding, or `bddSuite.lintTool` set to your binding's program, for live lint | The extension lints with the runtime it carries when you have no TypeScript binding | Live lint as you type with no settings; keep your program as the lint tool if you want the binding check (`E201`) as well |

**Versions.** Every package of a release, and the VS Code extension, carry
the same version (DEC-P03). Take the packages and the extension of one
release; the extension warns when your manifests pin another.

## Before you start

* The release you move to exists: its GitHub release lists the packages
  (`https://github.com/smartpcr/bdd-code-extension/releases`), and the C#
  packages are on this repository's GitHub Packages feed. Until the public
  registries are switched on, take the other languages from the release's
  files, as each runtime's README says.
* The VS Code extension of the same release is installed.
* Work on a branch. Keep the copy until your own tests pass on the package
  (below); rolling back is reverting the branch.

## The steps

### 1. Reference the package instead of the copy

| Language | Remove | Add |
| --- | --- | --- |
| C# | The copied `Bdd.Suite*` projects, their `ProjectReference`s and any `<Import>` of `Bdd.Suite.Testing.targets` | `<PackageVersion Include="Smartpcr.BddSuite" Version="x.y.z" />` and `Smartpcr.BddSuite.Testing` in `Directory.Packages.props` (or `Version=` on each reference); `<PackageReference Include="Smartpcr.BddSuite" />` in the extension and the binding program, `<PackageReference Include="Smartpcr.BddSuite.Testing" />` in the test project. Its targets import themselves. nuget.org has them (from 0.7.4; GitHub Packages had them as `Bdd.Suite*` before). |
| Go | A `replace` to a copy or a checkout | `go get github.com/smartpcr/bdd-code-extension/runtimes/go@vx.y.z` |
| Rust | A `path` dependency | `suiterun = { git = "https://github.com/smartpcr/bdd-code-extension", tag = "vx.y.z", features = ["testing"] }`, or the release's `.crate` |
| TypeScript | A `file:` dependency | `@bdd-suite/runtime` at `x.y.z` (the release's `.tgz` until it is on npm) |
| PowerShell | A copied `BddSuite` folder imported by path | `Install-PSResource BddSuite -Version x.y.z`, then `Import-Module BddSuite`; in a script, `#Requires -Modules @{ ModuleName = 'BddSuite'; RequiredVersion = 'x.y.z' }` |

Each language has a working consumer that does exactly this:
[samples/consumers](../../samples/consumers).

### 2. Drop the patches

`--name glob[,glob]`, `--progress` and the run observer, and a step whose
action throws anything failing that step while the run goes on, are in every
runtime (spec/progress.md). Delete local changes that added them and the
tests of those changes. The progress lines are the ones TAEF-shaped tooling
already reads: `StartGroup:`, the step lines, `EndGroup: … [Passed]`,
`Summary:`.

### 3. Import the core by name

In your catalog:

```yaml
catalogVersion: 1
imports:
  - bdd-suite:core        # was: a path to spec/core.catalog.yaml, or your copy of it
bindings: [csharp]        # the core's actions are cut to these, as your copy was by hand
```

Then delete the copy. A path import keeps working if you want to stay on it;
only `bdd-suite:core` is cut to your bindings.

### 4. Regenerate the schema with the extension's generator

Remove `bddSuite.schemaGenerator` from your settings (the default runs the
`Build-Schema.ps1` the extension carries on your catalog), run *Suite:
Regenerate the schema*, and commit the regenerated `suite.schema.json` and
`suite.schema.md`. Delete the checkout or junction you kept for it. Outside
VS Code, the same generator is in this repository's `spec/` at the release's
tag.

### 5. Check

* The build and your tests pass with the same counts as on the copy.
* `suiterun lint` is clean, and `suiterun run --name '<a case>' --progress`
  prints the progress lines your tooling reads.
* The extension's status bar names the lint tool you expect, and it shows no
  warning of another release.

If any of this fails, keep the copy, revert the branch, and report what
differs; nothing outside your repository changed.

## Worked example: update2

update2 (`E:\work\hci\update2`) is a consumer in C# whose suites run against
a lab. Its `test/e2e/UPSTREAM.md` records what it takes from here.

**Already done (its commit `fedc7b77c`).** Steps 1 and 2 for C#: its
`Directory.Packages.props` pins `Bdd.Suite` and `Bdd.Suite.Testing` at
0.7.0; `Urp.Bvt.Suite`, `Urp.Bvt.Suite.Cli` and `Urp.Bvt.Suite.MsTest`
reference them; the copy of `runtimes/csharp` and its patch tests are gone.

**What remains**, for the release that carries `bdd-suite:core` and the
bundled generator (the one after 0.7.1):

1. **Versions and IDs.** Both `PackageVersion` entries to that release, under
   the IDs nuget.org has them by, `Smartpcr.BddSuite` and
   `Smartpcr.BddSuite.Testing` (nuget.org reserves `Bdd.Suite`; the assemblies
   and namespaces are unchanged, so no code changes), with every
   `PackageReference` renamed to match; and the extension of the same release.
2. **The core.** `test/e2e/schema/actions.catalog.yaml` imports
   `core.catalog.yaml`, its copy narrowed by hand to `[csharp, powershell]`.
   It becomes:

   ```yaml
   imports:
     - bdd-suite:core
   bindings: [csharp]
   ```

   and `test/e2e/schema/core.catalog.yaml` is deleted. The catalog's
   `bindings` is `[csharp]`, so the core's actions are cut to `csharp`; if its
   PowerShell scripts still read the catalog, list `[csharp, powershell]`
   there instead, as the copy did.
3. **The generator.** `.vscode/settings.json` sets
   `bddSuite.schemaGenerator` to `test/e2e/bdd/spec/Build-Schema.ps1`, which
   needs the `test/e2e/bdd` link to a checkout of this repository. The setting
   is removed, the schema regenerated with *Suite: Regenerate the schema* and
   committed, and the link is no longer needed.
4. **The linter.** It sets `bddSuite.lintTool` and `targetBinding` to
   `csharp`, its own program. That stays: its program also checks what the C#
   binding implements (`E201`), which the extension's bundled linter does not.
5. **The record.** `test/e2e/UPSTREAM.md`: the core and the generator now
   come with the packages and the extension; the copy's section goes.
6. **Check.** Its build, `Urp.Bvt.Suite.UnitTest` and
   `Urp.Bvt.Suite.MsTest` with the same counts; its `suiterun` with `--name`
   and `--progress` on one suite (E12 of [design.md](design.md#e12)).

These are update2's changes, made on a branch in update2 and reviewed there;
this repository's plan records them as D18 and E12.
