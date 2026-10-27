## The PowerShell binding

`bindings/powershell`: `{{Namespace}}/{{Namespace}}.psm1` (the extension module),
`{{Namespace}}/actions/*.ps1` (one `Register-SuiteAction` per action),
`suiterun.ps1`, `bddsuite.tests.yaml` (what `generate` turns into Pester tests)
and `Invoke-Tests.ps1` (runs them). The packages, `BddSuite` {{version}},
`powershell-yaml` and `Pester`, are listed in `packages.psd1`; `restore.ps1`
puts them in `.modules/`, this workspace's own module path. Needs PowerShell 7.4
or later.

```powershell
pwsh -File restore.ps1                                     # once, and after packages.psd1 changes

$suiterun = 'bindings/powershell/suiterun.ps1'
pwsh -File $suiterun lint --path 'suites/*.yml' --schema-root schema --binding-check --binding powershell --strict
pwsh -File $suiterun run  --path 'suites/*.yml' --schema-root schema --progress --results out/results.xml --trace-file out/trace.json

pwsh -File $suiterun generate --config bindings/powershell/bddsuite.tests.yaml --out bindings/powershell/tests   # after adding or renaming a case
pwsh -File bindings/powershell/Invoke-Tests.ps1                    # every case; guarded suites skip
pwsh -File bindings/powershell/Invoke-Tests.ps1 -TagFilter smoke   # a tag
```

Reports: `out/results.xml` (NUnit 3; `--format junit` for JUnit),
`out/trace.json` (one entry per step), and Pester's `out/pester-results.xml`.
`Invoke-Tests.ps1 -AllowGuarded` runs guarded suites and `-TraceFile <path>`
writes the trace.
