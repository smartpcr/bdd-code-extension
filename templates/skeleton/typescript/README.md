## The TypeScript binding

`bindings/typescript`: `src/actions.ts` (one registration per action and its
handler), `src/extension.ts` (`{{prefix}}Extension`), `src/cli.ts` (suiterun),
`src/index.ts` (the runtime's library with the extension applied, which the
editor lints with) and `bddsuite.tests.yaml` (what `npm run generate` turns into
`node:test` tests). The package, `@bdd-suite/runtime` {{version}}, is a
dependency in `bindings/typescript/package.json`. Needs Node.js 24 or later.

```powershell
cd bindings/typescript
npm install
npm run build                                  # what Suite: Build lint tool runs (with npm install)
npm run generate                               # after adding or renaming a case or a suite
npm test                                       # every case; guarded suites skip
node --test --test-name-pattern echoes-text "tests/*.bdd.test.ts"   # one case
cd ../..

$suiterun = 'bindings/typescript/dist/cli.js'
node $suiterun lint --path 'suites/*.yml' --schema-root schema --binding-check --binding typescript --strict
node $suiterun run  --path 'suites/*.yml' --schema-root schema --progress --results out/results.xml --trace-file out/trace.json
```

Reports: `out/results.xml` (NUnit 3; `--format junit` for JUnit) and
`out/trace.json` (one entry per step); `node --test --test-reporter=junit` for
node's own. Under `npm test`, `BDD_SUITE_ALLOW_GUARDED=1` runs guarded suites and
`BDD_SUITE_TRACE_FILE=<path>` writes the trace.
