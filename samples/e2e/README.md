# End-to-end samples

Two workspaces that show the whole loop of YAML test suites with the Suite
Authoring extension, laid out like update2's
`src/UpdateResourceProvider/UpdateService/EnvironmentTest/BVT`
(`schema/`, `suites/`, `bindings/`):

1. a workspace's settings point the extension at its catalog, suites and binding;
2. a step written in a suite becomes a catalog entry and a binding stub (*Declare action*);
3. build, then run the suites with suiterun, or as generated MSTest or Pester tests;
4. read the console, the NUnit3 or JUnit report and the trace.

Demo video: [bdd suite e2e demo](https://www.youtube.com/watch?v=6JYugu594x8) (YouTube).

| Sample | Binding | Runtime package | Generated tests |
| --- | --- | --- | --- |
| [csharp/](csharp/README.md) | C# (`InventoryExtension`) | `Smartpcr.BddSuite`, `Smartpcr.BddSuite.Testing` 0.7.12 from nuget.org (`Directory.Packages.props`) | MSTest, at every build |
| [powershell/](powershell/README.md) | PowerShell (`Inventory.psm1`) | `BddSuite` 0.7.12, its release `.nupkg` (`packages.psd1`, `restore.ps1`) | Pester, by `suiterun.ps1 generate` |

Both hold the same suites and the same inventory domain, so they can be read
side by side; only the catalog's `bindings:` and the binding code differ.

Each sample is a workspace of its own: open the sample's folder in VS Code
(`code samples/e2e/csharp`), not this repository, and it uses its own
`.vscode/settings.json`. Neither refers to a path outside its folder or builds
anything of this repository, so either can be copied out and used as the
starting point of another repository's suites. Their package versions are
pinned to a published release, so they are not part of this repository's
lockstep version bump (`scripts/set-version.mjs`); move them when a newer
release is published.
