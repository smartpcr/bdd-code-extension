## The C# binding

`bindings/dotnet`: `{{Namespace}}.Suite` (the extension: `{{Namespace}}Extension`
registers each action, `{{Namespace}}Actions` holds the handlers),
`{{Namespace}}.Suite.Cli` (suiterun) and `{{Namespace}}.Suite.MsTest` (the suites as
MSTest tests, generated at every build from its `bddsuite.tests.yaml`). The
packages, `Smartpcr.BddSuite` and `Smartpcr.BddSuite.Testing` {{version}}, are
in `bindings/dotnet/Directory.Packages.props`; they come from nuget.org
(`nuget.config`). Needs the .NET 10 SDK.

```powershell
dotnet build bindings/dotnet/{{Namespace}}.Suite.slnx        # also generates the MSTest tests; a lint finding fails the build

$suiterun = 'bindings/dotnet/artifacts/bin/{{Namespace}}.Suite.Cli/Debug/net10.0/suiterun.exe'
& $suiterun lint --path 'suites/*.yml' --schema-root schema --binding-check --binding csharp --strict
& $suiterun run  --path 'suites/*.yml' --schema-root schema --progress --results out/results.xml --trace-file out/trace.json

dotnet test bindings/dotnet/{{Namespace}}.Suite.MsTest                              # every case; guarded suites skip
dotnet test bindings/dotnet/{{Namespace}}.Suite.MsTest --filter TestCategory=smoke  # a tag
```

*Suite: Build lint tool* runs the same build, so the editor lints with this
suiterun. Reports: `out/results.xml` (NUnit 3; `--format junit` for JUnit),
`out/trace.json` (one entry per step), and the TRX of
`dotnet test --logger trx` in `bindings/dotnet/artifacts/TestResults`. Under
`dotnet test`, `BDD_SUITE_ALLOW_GUARDED=1` runs guarded suites,
`BDD_SUITE_PROGRESS=1` prints each step and `BDD_SUITE_TRACE_FILE=<path>` writes
the trace.
