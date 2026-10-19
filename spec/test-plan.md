# The test plan and `suiterun generate`

Each runtime's `suiterun generate` writes test code for one test framework
(MSTest, NUnit, xUnit, Go `testing`, a Rust harness, `node:test`, Vitest, Jest,
Pester) from a project's suite files. Before it writes anything it builds a
**test plan**: the language-independent list of suites and cases the code will
declare. All five runtimes must build the same plan from the same inputs, which
is what keeps five generators naming, selecting and guarding tests alike; the
corpus in [conformance/generate/](../conformance/generate/) pins it. The plan's
shape is [test-plan.schema.json](test-plan.schema.json); the config it is built
from is [tests.config.schema.json](tests.config.schema.json). How the generated
code runs a case is [session.md](session.md).

## The config: `bddsuite.tests.yaml`

One per test project, at its root. Paths in it are relative to the file and
use forward slashes.

```yaml
suites: [ "../suites/**/*.yml" ]       # which files to consider
exclude: [ "../suites/_lib/**" ]       # never considered (optional)
schemaRoot: ../schema                   # actions.catalog.yaml and suite.schema.json
provider: mstest                        # optional where it can be detected
extensions: [ "MyCompany.Actions.OrdersExtension" ]   # in the language's own terms
offlineActions: [ "core.*", "wait", "orders.*" ]     # what may run without an opt-in
output: { namespace: MyCompany.Suites.Tests }        # language-specific naming
```

## Building the plan

1. **Files.** Every file matching `suites` and not `exclude`, as a path relative
   to the config's folder with forward slashes, in ordinal order of that path.
2. **Suites.** A file is a suite when its top level has a `suite` key; any other
   matching file (a library, which declares and never runs) is left out
   silently. A suite that does not lint clean stops the whole plan: `generate`
   prints the runtime's diagnostics with their positions and exits 2, writing
   nothing, because partial test code would silently drop cases.
3. **Suite name.** The `suite` value.
4. **Cases.** The suite's cases in file order; a case with `examples` becomes one
   case per row, in row order, named `<name> [<column>=<value>, ...]` exactly as
   the runtime's whole-file run names it, with `outline` set to the case's own
   name and `row` to the row's values.
5. **Tags.** A case's tags are its own, then the suite's, without repeats, in
   that order. A suite's tags are its own.
6. **Guard.** A suite is **guarded** when any step it can run names an action
   that `offlineActions` does not cover. "Any step it can run" is every step of
   `setup`, `beforeEach`, `afterEach`, `teardown` and every case's `setup`,
   `steps` and `cleanup`, with meta steps expanded (including those from
   imported libraries) and the step a `wait` polls (`forStep`) included. A
   pattern covers an action when it equals the name, or ends in `.*` and the
   name starts with the text before the `*`. `guardedBy` lists the uncovered
   actions, sorted ordinally, without repeats. With no `offlineActions` in the
   config, no suite is guarded.

## Identifiers

Generated code needs a name for each suite (a class, a function, a file) and,
in C#, for each case (a method). The plan carries one identifier, `id`, for
each, so the five generators agree.

1. **Words.** The words of a name are its maximal runs of ASCII letters and
   digits; every other character, including any non-ASCII letter, separates
   words.
2. **Join.** Each word's first character is upper-cased (ASCII), the rest kept
   as they are, and the words are joined: `rejects a bad quantity [qty=0]`
   gives `RejectsABadQuantityQty0`.
3. **Empty or leading digit.** A name with no word gives `Suite` for a suite and
   `Case` for a case. An identifier that starts with a digit gets `N` in front:
   `3 retries` gives `N3Retries`.
4. **Reserved.** Within a suite, these case identifiers are taken before any
   case is named, because generated code declares members with them: `Setup`,
   `Teardown`, `BeforeEach`, `AfterEach`, `TestContext`, `Session`.
5. **Collisions.** Identifiers are compared ignoring ASCII case (generated
   files are named after suites, and some file systems ignore case). A suite's
   identifier must differ from every earlier suite's; a case's from every
   earlier case's in the same suite and from the reserved ones. A taken
   identifier gets `_2`, then `_3`, and so on, the first one free:
   `rejects [qty=-1]` after `rejects [qty=1]` gives `RejectsQty1_2`.
6. **Generators.** Generated names add a fixed prefix that no plan identifier
   can produce (plan identifiers contain `_` only before a collision number):
   C# classes are `Suite_<id>` and methods `<id>`; Go functions are
   `TestSuite_<id>`; files are `<id>.g.cs`, `<id>_bdd_test.go`,
   `<id>.bdd.test.ts`, `<id>.Bdd.Tests.ps1`.

The display name of every test is the case's exact `name`, and that is what
generated code passes to the session; identifiers are never used to find a
case.

## The plan

```json
{
  "planVersion": 1,
  "suites": [
    {
      "file": "suites/orders.yml",
      "name": "orders",
      "id": "Orders",
      "tags": ["shop"],
      "guarded": false,
      "guardedBy": [],
      "cases": [
        { "name": "places an order", "id": "PlacesAnOrder", "tags": ["smoke", "shop"] },
        { "name": "rejects a bad quantity [qty=0]", "id": "RejectsABadQuantityQty0",
          "outline": "rejects a bad quantity", "row": { "qty": 0 }, "tags": ["shop"] }
      ]
    }
  ]
}
```

`outline` and `row` are present only for an examples row. Row values keep their
YAML types.

## The command line

```text
suiterun generate --config <bddsuite.tests.yaml> [--provider <name>] [--out <folder>]
suiterun generate --config <file> --plan        print the plan as JSON; write nothing
suiterun generate --config <file> --check       exit 1, naming each file, if what is on disk differs
```

`--plan` writes UTF-8 without a byte-order mark, whatever the console's code
page: case names are free text (`café au lait`), and a plan read back through
a legacy code page would no longer match. Generated files are UTF-8 too.

Exit codes follow the rest of `suiterun`: 0 written (or up to date), 1 stale
under `--check`, 2 a refused config or a suite that does not lint clean.
