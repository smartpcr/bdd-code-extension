# The suite schema

This directory holds the vocabulary the five bindings share. Everything in it is
data: no binding compiles any of it in, and all five read these files at run
time, so none of them can hold an opinion about the format that the others do
not.

| File | What it is |
| --- | --- |
| `suite.base.json` | The hand-written half of the schema: everything that is not an action. |
| `actions.catalog.yaml` | Every action, what it takes, what it captures, and which bindings implement it. |
| `actions.catalog.schema.json` | The shape the catalog itself has to have. |
| `suite.schema.json` | Generated. The base with one branch per action merged into it. |
| `suite.schema.md` | Generated. The same thing as a page a person reads. |
| `diagnostic.schema.json` | The object `lint --json` writes, one per finding. |
| `diagnostics.md` | Every code from `E100` to `W304`, and what each one means. |

`suite.schema.json` and `suite.schema.md` are written by `Build-Schema.ps1`.
Edit `suite.base.json` or `actions.catalog.yaml` and run it:

```powershell
pwsh -File test/e2e/schema/Build-Schema.ps1
```

The `suite-lint` workflow runs it with `-Check` and fails a change where the
committed pair does not match a fresh generation, so the two cannot drift.

## Editing a suite with the schema attached

Y7.3. The point of a generated schema is that an author sees a mistake while
typing it, not when a lint job runs minutes later. Every editor below reads the
same `suite.schema.json` the bindings enforce.

### Visual Studio Code

Nothing to do. `.vscode/settings.json` is committed and maps the suite paths to
the schema; install the YAML extension (`redhat.vscode-yaml`) and it works. The
mapping covers `test/e2e/suites/**`, the shared library under `_lib/`, and the
`validate/` and `execute/` corpus fixtures.

### Any editor with a YAML language server

The same mapping, given to `yaml-language-server` directly. Neovim with
`nvim-lspconfig`, Helix, Emacs with `lsp-mode` and JetBrains IDEs all take it:

```json
{
  "yaml.schemas": {
    "./test/e2e/schema/suite.schema.json": [
      "test/e2e/suites/*.yml",
      "test/e2e/suites/_lib/*.yml",
      "test/e2e/conformance/validate/*.yml",
      "test/e2e/conformance/execute/*.yml"
    ]
  }
}
```

### One file at a time, with no configuration at all

A modeline at the top of a suite works in any editor that reads one, and needs
no settings file:

```yaml
# yaml-language-server: $schema=../schema/suite.schema.json
```

None of the checked-in suites carries one, because the workspace mapping already
covers them. It is there for a suite written somewhere else.

## What the editor catches, and what it does not

The schema is one of the three levels of validation the design defines
(DEC-Y05), and it is the first. An editor shows what a schema can see and
nothing more.

| Mistake | Editor | `lint` |
| --- | --- | --- |
| A key nothing declares, such as `assert:` for `asserts:` | yes, `E101` | yes |
| A required key that is missing | yes, `E102` | yes |
| A value of the wrong type, such as `timeoutSec: "30"` | yes, `E103` | yes |
| An action nothing declares | yes, `E104` | yes |
| A parameter the action does not take | yes, `E105` | yes |
| A reference that resolves to nothing | no | yes, `E301` |
| A capture read before the step that produces it | no | yes, `E303` |
| A meta step that forms a cycle | no | yes, `E207` |
| A binding that does not implement an action | no | yes, `E201`, with `--binding-check` |

The second and third levels need the whole file and the catalog together, which
is what `lint` is for:

```powershell
pwsh -File scripts/e2e/Invoke-LabTestSuite.ps1 -Path 'test/e2e/suites/*.yml' -Lint
```

### What to check on a screen, and what is already checked for you

Editor integration is the one thing in this plan a test cannot assert, because
what it produces is a squiggle on a screen. What it reads, though, is a file, and
that file is checked: `test/e2e/schema/Schema.Tests.ps1` asserts the three
properties an editor needs before it can underline anything, and the `suite-lint`
workflow runs it on every change.

| The editor behaviour | What the test asserts about the schema |
| --- | --- |
| `assert:` for `asserts:` underlines on a case | `case` declares `asserts`, does not declare `assert`, and is closed |
| `nodee:` underlines on a `cluster.suspend` step | `step.cluster.suspend` declares `node`, not `nodee`, and is closed |
| Completion after `action: cluster.state` offers `captureAs` | `step.cluster.state` declares `captureAs` among its properties |

A closed object is what makes an editor underline rather than shrug: without
`additionalProperties: false` a schema has no opinion about a key it has never
heard of, and neither has the editor.

The squiggle itself is worth looking at once, in VS Code with
`redhat.vscode-yaml`, after any change to `Build-Schema.ps1` that alters how the
per-action branches are generated. Open `test/e2e/suites/smoke.yml`, make one of
the three mistakes above, and confirm the underline appears. Nothing here records
a result for that, because nobody can check it for you.
