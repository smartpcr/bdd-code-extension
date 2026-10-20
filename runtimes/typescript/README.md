# The TypeScript runtime

The package `@bdd-suite/runtime`: the suite model, lint (also as an in-process
library for editors), the run (`runFile`, the session), reports and the
`suiterun` command line, extensible through its extension API. It is held to
the conformance corpus in `../../conformance/` like every runtime.

## Run suites with your test framework

`suiterun generate` turns a project's suites into `node:test`, Vitest or Jest
tests: one file per suite, a `describe` named after it, and one test per case
and examples row (docs/test-providers, D12).

**1. A config**, `bddsuite.tests.yaml` (spec/test-plan.md):

```yaml
suites: [ "../suites/*.yml" ]
schemaRoot: ../schema
extensions: [ "my-actions#shop" ]               # module specifier and export
contextKeys: [ store ]                          # what the extensions add, for linting before they load
offlineActions: [ "core.*", "wait", "shop.*" ]  # a suite using anything else is guarded
```

**2. Generate**, for example from an npm `pretest` script:

```text
npx suiterun generate --config bddsuite.tests.yaml --out tests [--provider node|vitest|jest]
```

It writes one `<Id>.bdd.test.ts` per suite and removes only files it wrote.
Without `--provider` it takes the config's, else Vitest or Jest when the
nearest `package.json` depends on one, else `node:test`. Commit the files or
not, as you prefer; when committed, `--check` in CI exits 1 naming each stale
one. A suite that does not lint clean stops generation with its findings
(exit 2); `--plan` prints the test plan instead.

**3. Run:**

```text
node --test "tests/*.bdd.test.ts"
node --test --test-reporter=@bdd-suite/runtime/testing/node-reporter --test-reporter-destination=junit.xml "tests/*.bdd.test.ts"
npx vitest run [-t 'places an order']
node --experimental-vm-modules node_modules/jest/bin/jest.js [-t 'places an order']
```

The generated files carry no types, so Jest runs them as ES modules with no
transform (`transform: {}`, `extensionsToTreatAsEsm: ['.ts']`). Vitest 5's
`vitest list` parses the source by default and cannot see the generated
tests: use `vitest list --staticParse=false`.

The run context comes from the environment, under the extensions' prefix
(`BDD_SUITE_` by default): `BDD_SUITE_TAGS`, `BDD_SUITE_OPTION_<FLAG>`,
`BDD_SUITE_PARAM_<NAME>`, `BDD_SUITE_DRY_RUN=1`, `BDD_SUITE_TRACE_FILE` and
`BDD_SUITE_RECORD_PATH`. Each test file is its own run context in every
framework's default isolation, and appends its trace entries to the one
trace file, so start a run with no file there.

**Skips.** A case the tag filter does not select, every case of a guarded
suite without `BDD_SUITE_ALLOW_GUARDED=1`, and a dry run's cases are declared
skipped when the file loads (Jest cannot skip at run time). `node:test` shows
the reason; Vitest and Jest show the test skipped.

**A failed suite teardown** fails the describe's after-all hook, never a case
that passed. It shows as a test case named after the describe in Vitest's
JUnit report and in the runtime's `node:test` reporter (node's own JUnit
reporter drops it), and as jest-junit's "Test execution failure" case.

The library: `import { suite, runContextFromEnv, openSession } from
'@bdd-suite/runtime/testing'` (the session is also exported from the package
root). A working project for all three frameworks:
`../../samples/workspace/tests/typescript`. The contract the generated code
drives is `../../spec/session.md`.
