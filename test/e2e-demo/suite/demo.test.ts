// The demo, inside VS Code with the extension installed from its .vsix and the
// self-contained fixture open. Each step says what it shows, so the output
// reads as a walkthrough: navigation from a YAML step to the action's catalog
// entry and to its implementation in each language, back again, and code
// generation from an undeclared action to stubs in five languages, which the
// navigation then reaches. The fixture is in the default layout (DEC-S11): each
// language's actions are the workspace's extension of that language's runtime.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import type { ScaffoldResult } from '../../../src/features/scaffold';

const ws = () => process.env.DEMO_WORKSPACE!;
const at = (...parts: string[]) => vscode.Uri.file(path.join(ws(), ...parts));
const SUITE = () => at('test', 'e2e', 'suites', 'demo.yml');
const ORDERS = () => at('test', 'e2e', 'suites', 'orders.yml');
const LIBRARY = () => at('test', 'e2e', 'suites', '_lib', 'orders-steps.yml');
const CATALOG = () => at('test', 'e2e', 'schema', 'actions.catalog.yaml');
const GO = () => at('test', 'e2e', 'bindings', 'go', 'actions', 'actions.go');
const RUST = () => at('test', 'e2e', 'bindings', 'rust', 'src', 'actions.rs');
const CSHARP = () => at('test', 'e2e', 'bindings', 'dotnet', 'Suite.Cli', 'Actions.cs');
const TS = () => at('test', 'e2e', 'bindings', 'typescript', 'src', 'actions.ts');
const PS = (name: string) => at('scripts', 'e2e', 'actions', `${name}.ps1`);
// LF whatever the checkout used: on a Windows CI runner git checks the fixture out
// with CRLF, and the extension's edits keep each file's own line endings.
const read = (uri: vscode.Uri) => fs.readFileSync(uri.fsPath, 'utf8').replace(/\r\n/g, '\n');
const rel = (uri: vscode.Uri) => path.relative(ws(), uri.fsPath).split(path.sep).join('/');

let api: TestApi;

async function within(ms: number, ok: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`not true within ${ms} ms`);
    await new Promise(r => setTimeout(r, 50));
  }
}

async function open(uri: vscode.Uri): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  return doc;
}

/** The position `offset` characters into the `occurrence`-th match of `needle`. */
function find(doc: vscode.TextDocument, needle: string, offset = 0, occurrence = 0): vscode.Position {
  let i = -1;
  for (let n = 0; n <= occurrence; n++) i = doc.getText().indexOf(needle, i + 1);
  assert.ok(i >= 0, `${needle} in ${rel(doc.uri)}`);
  return doc.positionAt(i + offset);
}

/** Each location as `file:line  text`, one-based, sorted. */
async function describeAll(locations: (vscode.Location | vscode.LocationLink)[]): Promise<string[]> {
  const out: string[] = [];
  for (const l of locations) {
    const uri = 'uri' in l ? l.uri : l.targetUri;
    const range = 'range' in l ? l.range : l.targetSelectionRange ?? l.targetRange;
    const doc = await vscode.workspace.openTextDocument(uri);
    out.push(`${rel(uri)}:${range.start.line + 1}  ${doc.lineAt(range.start.line).text.trim()}`);
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

const implementations = (uri: vscode.Uri, pos: vscode.Position) =>
  vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeImplementationProvider', uri, pos);
const definitions = (uri: vscode.Uri, pos: vscode.Position) =>
  vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', uri, pos);
const references = async (uri: vscode.Uri, pos: vscode.Position) =>
  ((await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, pos)) ?? [])
    .filter(l => l.uri.fsPath.endsWith('.yml'));
const codeActions = async (uri: vscode.Uri, pos: vscode.Position) =>
  (await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, new vscode.Range(pos, pos))) ?? [];
const lintShown = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).filter(d => (d.source ?? '').startsWith('suiterun:'));
/** Lint now; a lint a settings rebuild or the open-file lint cancelled or superseded is asked again. */
async function lintSettled(uri: vscode.Uri) {
  let event = await api.controllers[0].lintNow(uri);
  for (let tries = 0; tries < 5 && (event.outcome === 'cancelled' || event.outcome === 'superseded'); tries++) {
    await api.ready;
    event = await api.controllers[0].lintNow(uri);
  }
  return event;
}
const sitesOf = (action: string) => api.indexers[0].index.sitesFor(action).map(s => s.binding).sort();

function show(title: string, lines: string[]): void {
  console.log(`      ${title}`);
  for (const l of lines) console.log(`        ${l}`);
}

/** The lines of `text` from the first containing `from`, `count` long. */
function excerpt(text: string, from: string, count: number): string[] {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex(l => l.includes(from));
  return i < 0 ? [`(no line containing ${from})`] : lines.slice(i, i + count);
}

describe('Suite Authoring, installed from its .vsix, in a self-contained workspace', function () {
  this.timeout(120_000);

  before(async () => {
    const ext = vscode.extensions.getExtension('asz.bdd-suite')!;
    api = (await ext.activate()) as TestApi;
    await api.ready;
    await within(20_000, () => sitesOf('demo.greet').length === 5);
  });

  it('runs from the installed package, not from a source tree', () => {
    const ext = vscode.extensions.getExtension('asz.bdd-suite')!;
    assert.ok(ext.extensionPath.toLowerCase().startsWith(process.env.DEMO_EXTENSIONS_DIR!.toLowerCase()), ext.extensionPath);
    assert.strictEqual(ext.packageJSON.version, process.env.DEMO_VSIX_VERSION);
    assert.ok(!fs.existsSync(path.join(ext.extensionPath, 'src')));
    console.log(`      ${ext.id}@${ext.packageJSON.version} from ${ext.extensionPath}`);
  });

  it('indexes the catalog, the YAML suite and the registrations in five languages', () => {
    const ix = api.indexers[0].index;
    assert.deepStrictEqual([...ix.catalog!.actions.keys()].sort(), ['demo.count', 'demo.greet', 'orders.create', 'orders.ship']);
    assert.deepStrictEqual(sitesOf('orders.create'), ['csharp', 'powershell']);
    assert.deepStrictEqual(sitesOf('orders.ship'), ['powershell']);
    assert.ok(ix.isSuiteOrLibrary(ORDERS().fsPath) && ix.isSuiteOrLibrary(LIBRARY().fsPath));
    assert.deepStrictEqual(sitesOf('demo.greet'), ['csharp', 'go', 'powershell', 'rust', 'typescript']);
    assert.deepStrictEqual(sitesOf('demo.count'), ['go', 'powershell']);
    assert.ok(ix.isSuiteOrLibrary(SUITE().fsPath));
    show('registrations found:', ix.allSites().map(s => `${s.action} in ${s.binding}: ${rel(vscode.Uri.file(s.file))}:${s.range.start.line + 1}`).sort());
  });

  it('Test Explorer: Run on demo.yml asks nothing (its actions are offline), runs the stand-in runner, and shows each case\'s result; Run on one case runs that case', async () => {
    const t = api.testing;
    const ui = t.ui;
    const asked: string[] = [];
    t.ui = {
      async askLab(_have, missing) { asked.push(...missing); return undefined; },
      async confirmLab() { asked.push('confirmation'); return false; },
      async confirmStop() { return false; },
    };
    const run = async (item: vscode.TestItem) => {
      t.results.clear();
      await t.runProfile.runHandler(new vscode.TestRunRequest([item]), new vscode.CancellationTokenSource().token);
    };
    const r = (c: string) => t.results.get(`${rel(SUITE())}::${c}`);
    const line = (c: string) => `${c}: ${r(c)!.state}${r(c)!.message ? ` - ${r(c)!.message}` : ''}`;
    try {
      const item = t.controller.items.get(rel(SUITE()))!;
      assert.ok(item, 'demo.yml is a test item');
      const started = Date.now();
      await run(item);
      assert.deepStrictEqual(asked, [], 'bddSuite.offlineActions makes demo.* offline: no lab values, no confirmation');
      assert.deepStrictEqual(r('greets-and-counts'), { state: 'passed' });
      assert.deepStrictEqual(r('greets-again'), { state: 'passed' });
      assert.deepStrictEqual(r('says-farewell'), { state: 'failed', message: 'then: a farewell is said failed (demo.farewell is not implemented in PowerShell)' });
      assert.match(t.lastCommand.get(rel(SUITE()))!.join(' '), /scripts[\\/]e2e[\\/]suiterun\.ps1 run --path test\/e2e\/suites\/demo\.yml .*--format nunit3$/,
        'the PowerShell program, with the verb and flags of every program and no lab flags offline');
      show(`Run of demo.yml (${Date.now() - started} ms):`, ['greets-and-counts', 'greets-again', 'says-farewell'].map(line));

      await run(item.children.get(`${rel(SUITE())}::greets-and-counts`)!);
      assert.deepStrictEqual([...t.results.keys()], [`${rel(SUITE())}::greets-and-counts`], 'only the chosen case has a result');
      assert.ok(t.lastCommand.get(rel(SUITE()))!.join(' ').includes('--test-name greets-and-counts'));
      show('Run of greets-and-counts alone:', [line('greets-and-counts')]);
    } finally {
      t.ui = ui;
    }
  });

  it('YAML to code: Go to Definition (F12, Ctrl+click) on `action: demo.greet` opens the catalog entry and each language\'s handler', async () => {
    const doc = await open(SUITE());
    const found = await describeAll(await definitions(doc.uri, find(doc, 'action: demo.greet', 'action: '.length + 2)));
    assert.deepStrictEqual(found, [
      "scripts/e2e/actions/DemoGreet.ps1:5  Register-SuiteAction -Name 'demo.greet' -Handler {",
      'test/e2e/bindings/dotnet/Suite.Cli/Actions.cs:17  private static object? DemoGreet(ActionRequest request) =>',
      'test/e2e/bindings/go/actions/actions.go:19  func demoGreet(request *actions.Request) (any, error) {',
      'test/e2e/bindings/rust/src/actions.rs:13  fn demo_greet(request: &Request) -> Outcome {',
      'test/e2e/bindings/typescript/src/actions.ts:8  async function demoGreet(request: Request) {',
      'test/e2e/schema/actions.catalog.yaml:8  - name: demo.greet',
    ]);
    show('Go to Definition (Ctrl+click) on demo.greet; PowerShell\'s handler is its inline script block:', found);
  });

  it('YAML to implementation: demo.count is implemented in PowerShell and Go only, and hover says who cannot run it', async () => {
    const doc = await open(SUITE());
    const pos = find(doc, 'action: demo.count', 'action: '.length + 2);
    const found = await describeAll(await definitions(doc.uri, pos));
    assert.strictEqual(found.length, 3, found.join('\n'));
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, pos);
    const text = hovers.flatMap(h => h.contents.map(c => (typeof c === 'string' ? c : c.value))).join('\n');
    assert.match(text, /\*\*demo\.count\*\* - Count from one to a number\./);
    for (const b of ['C#', 'Rust', 'TypeScript']) assert.match(text, new RegExp(`- ${b.replace('#', '\\#')}: not implemented`));
    show('Go to Definition on demo.count:', found);
    show('hover:', text.split('\n').filter(l => l.startsWith('- ')));
  });

  it('implementation to YAML: from each language\'s registration, Find References lists the YAML steps that use the action', async () => {
    const want = ['test/e2e/suites/demo.yml:7  action: demo.greet', 'test/e2e/suites/demo.yml:17  action: demo.greet'];
    const sources: [vscode.Uri, string][] = [
      [GO(), 'Name: "demo.greet"'], [RUST(), 'Action::new("demo.greet"'], [CSHARP(), 'ActionRegistration("demo.greet"'],
      [TS(), "action('demo.greet'"], [PS('DemoGreet'), "'demo.greet'"], [CATALOG(), '- name: demo.greet'],
    ];
    for (const [uri, needle] of sources) {
      const doc = await open(uri);
      const pos = find(doc, needle, needle.indexOf('demo.greet') + 2);
      assert.deepStrictEqual(await describeAll(await references(uri, pos)), want, rel(uri));
    }
    // Shift+F12 on the handler's own name, where the method or function is declared.
    const methods: [vscode.Uri, string][] = [
      [CSHARP(), 'DemoGreet(ActionRequest'], [GO(), 'demoGreet(request *actions.Request'], [RUST(), 'demo_greet(request'], [TS(), 'demoGreet(request: Request'],
    ];
    for (const [uri, needle] of methods) {
      const doc = await open(uri);
      assert.deepStrictEqual(await describeAll(await references(uri, find(doc, needle, 2))), want, `${rel(uri)} at ${needle}`);
    }
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', GO(), 100);
    const lens = lenses.find(l => l.command?.title.includes('suite step'));
    assert.strictEqual(lens?.command?.title, '2 suite steps');
    show('Find References (Shift+F12) from each registration, each handler declaration and the catalog, each:', want);
    console.log(`      CodeLens on the Go registration and on func demoGreet: "${lens!.command!.title}"`);
  });

  it('validation: a missing required parameter (demo.greet without `name`), an unknown one and a wrong type are each reported', async () => {
    const scratch = at('test', 'e2e', 'suites', 'scratch.yml');
    fs.writeFileSync(scratch.fsPath, [
      'suite: scratch',
      'tests:',
      '  - name: checks',
      '    steps:',
      '      - given: a greeting without a name',
      '        action: demo.greet',
      '      - when: a misspelt parameter',
      '        action: demo.greet',
      '        name: world',
      '        nmae: x',
      '      - then: a count of words',
      '        action: demo.count',
      '        to: three',
      '',
    ].join('\n'));
    try {
      await within(10_000, () => api.indexers[0].index.isSuiteOrLibrary(scratch.fsPath));
      const doc = await open(scratch);
      const linted = await lintSettled(scratch);
      assert.strictEqual(linted.outcome, 'published', linted.status);
      const lint = lintShown(scratch).map(d => `${d.code} ${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message.split('\n')[0]}`);
      assert.deepStrictEqual(lint, [
        'E102 5:9 demo.greet needs the parameter name (Who to greet.).',
        'E105 10:9 demo.greet takes no parameter nmae; it takes name, punctuation.',
        'E103 13:13 demo.count\'s to is an integer, not a string.',
      ]);
      assert.match(lintShown(scratch)[1].message, /\nDid you mean name\?$/, 'the nearest parameter is suggested');
      // While typing, from the generated schema, before any lint runs.
      await within(20_000, () => vscode.languages.getDiagnostics(scratch).some(d => !(d.source ?? '').startsWith('suiterun:') && /name/.test(d.message)));
      const schema = vscode.languages.getDiagnostics(scratch).filter(d => !(d.source ?? '').startsWith('suiterun:'))
        .map(d => `${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message.split('\n')[0]}`);
      show('lint (tools/fake-lint.mjs, on open and save):', lint);
      show('schema (while typing; in BDD Suite mode the extension checks it, in YAML mode the YAML extension does):', schema);
      void doc;
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      fs.rmSync(scratch.fsPath, { force: true });
    }
  });

  it('IntelliSense: `action:` offers the catalog\'s actions with where each is implemented, and choosing one inserts its required parameters', async () => {
    const scratch = at('test', 'e2e', 'suites', 'scratch-complete.yml');
    fs.writeFileSync(scratch.fsPath, 'suite: scratch\ntests:\n  - name: typing\n    steps:\n      - given: a greeting\n        action: demo.gr\n');
    try {
      await within(10_000, () => api.indexers[0].index.isSuiteOrLibrary(scratch.fsPath));
      const doc = await open(scratch);
      const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(5, 23));
      const greet = list.items.find(i => i.label === 'demo.greet');
      const count = list.items.find(i => i.label === 'demo.count');
      assert.ok(greet && count, list.items.map(i => String(i.label)).join(', '));
      assert.strictEqual((greet!.insertText as vscode.SnippetString).value, 'demo.greet\n        name: $1', 'the required parameter is inserted below, at the step\'s key column');
      assert.strictEqual(count!.detail, 'PS Go · not in C# Rs TS');
      assert.strictEqual(greet!.detail, 'PS C# Go Rs TS');

      // The schema's parameter completion inside a demo.greet step.
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(5, 16, 5, 23), 'demo.greet\n        name: world\n        ');
      await vscode.workspace.applyEdit(edit);
      let keys: string[] = [];
      await within(20_000, async () => {
        const items = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(7, 8));
        keys = items.items.map(i => (typeof i.label === 'string' ? i.label : i.label.label));
        return keys.includes('punctuation');
      });
      show('completion on `action: demo.gr`:', [`demo.greet  ${greet!.detail}  inserts: ${JSON.stringify((greet!.insertText as vscode.SnippetString).value)}`, `demo.count  ${count!.detail}`]);
      show('completion on a new key in the demo.greet step (from the schema):', keys.filter(k => ['punctuation', 'name', 'captureAs', 'given', 'asserts'].includes(k)));
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      fs.rmSync(scratch.fsPath, { force: true });
    }
  });

  it('assistance: a CodeLens above each step whose action is missing somewhere names where, and offers to implement or declare it', async () => {
    const doc = await open(SUITE());
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri, 100);
    const at = (needle: string) => lenses.filter(l => l.range.start.line === find(doc, needle).line).map(l => l.command?.title);
    assert.deepStrictEqual(at('action: demo.count'),
      ['Not implemented in C#, Rust, TypeScript', '$(add) Implement in C#', '$(add) Implement in Rust', '$(add) Implement in TypeScript']);
    assert.deepStrictEqual(at('action: demo.farewell'), ['$(lightbulb) Declare action demo.farewell']);
    assert.deepStrictEqual(at('action: demo.greet'), [], 'implemented everywhere: nothing to offer');
    show('CodeLens above `action: demo.count`:', at('action: demo.count').map(String));
    show('CodeLens above `action: demo.farewell`:', at('action: demo.farewell').map(String));
  });

  it('the BDD Suite language mode: suites open in it, a .yml named for a suite, feature or test too, any other .yml stays YAML', async () => {
    fs.mkdirSync(at('config').fsPath, { recursive: true });
    fs.writeFileSync(at('config', 'checkout-feature.yml').fsPath, 'suite: checkout\ntests: []\n');
    fs.writeFileSync(at('config', 'notes.yml').fsPath, 'notes: plain YAML\n');
    try {
      assert.strictEqual((await open(SUITE())).languageId, 'bdd-suite', 'demo.yml, by the folder association in .vscode/settings.json');
      assert.strictEqual((await open(at('config', 'checkout-feature.yml'))).languageId, 'bdd-suite', 'by its name');
      assert.strictEqual((await open(at('config', 'notes.yml'))).languageId, 'yaml', 'a .yml that is not a suite keeps YAML');
      const langs = await vscode.languages.getLanguages();
      assert.ok(langs.includes('bdd-suite'), 'BDD Suite is offered in Change Language Mode');
      show('language modes:', ['demo.yml: bdd-suite (folder association)', 'config/checkout-feature.yml: bdd-suite (name)', 'config/notes.yml: yaml']);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(at('config').fsPath, { recursive: true, force: true });
    }
  });

  it('syntax highlighting: actions by where they are implemented, parameters by the action, schema keys, meta steps', async () => {
    const W = vscode.ConfigurationTarget.Workspace;
    // With C# as the target, demo.count (PowerShell and Go only) is implemented, but not by the target.
    await vscode.workspace.getConfiguration('bddSuite').update('targetBinding', 'csharp', W);
    try {
      await within(20_000, async () => (await api.indexers[0]?.ready, api.indexers[0]?.layout.settings.targetBinding === 'csharp'));
      const doc = await open(SUITE());
      const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>('vscode.provideDocumentSemanticTokensLegend', doc.uri);
      let named: string[] = [];
      await within(10_000, async () => {
        const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', doc.uri);
        named = [];
        let line = 0;
        let char = 0;
        for (let i = 0; i < tokens.data.length; i += 5) {
          const [dl, dc, len, type, mods] = Array.from(tokens.data.slice(i, i + 5));
          line += dl;
          char = dl === 0 ? char + dc : dc;
          const modifiers = legend.tokenModifiers.filter((_, bit) => mods & (1 << bit));
          named.push(`${line + 1}:${char + 1} ${doc.lineAt(line).text.slice(char, char + len)} ${legend.tokenTypes[type]}${modifiers.map(m => `.${m}`).join('')}`);
        }
        return named.some(n => n.includes('demo.count action.notInTarget'));
      });
      for (const want of [
        '7:17 demo.greet action.implemented', '8:9 name parameter.required',
        '9:20 greeting variable.declaration', '11:17 demo.count action.notInTarget', '12:9 to parameter.required',
        '23:17 demo.farewell action.undeclared', '24:9 name parameter', '25:9 loud parameter',
      ]) assert.ok(named.includes(want), `${want} in\n${named.join('\n')}`);
      // given/when/then and captureAs keep the grammar's colour: no property token paints over them.
      for (const grammar of ['6:9 given property', '9:9 captureAs property']) assert.ok(!named.includes(grammar), `${grammar} in\n${named.join('\n')}`);
      const rules = vscode.workspace.getConfiguration('editor').inspect<{ rules?: Record<string, unknown> }>('semanticTokenColorCustomizations')?.defaultValue?.rules ?? {};
      show('semantic tokens in demo.yml (target C#):', named);
      show('default styles the extension contributes:', Object.keys(rules).filter(k => k.endsWith(':bdd-suite')));
    } finally {
      await vscode.workspace.getConfiguration('bddSuite').update('targetBinding', undefined, W);
      await within(20_000, () => api.indexers[0]?.layout.settings.targetBinding === 'powershell');
    }
  });

  it('code generation 1: lint reports E104 for the undeclared demo.farewell, and its quick fix declares it', async () => {
    const doc = await open(SUITE());
    const linted = await lintSettled(SUITE());
    assert.strictEqual(linted.outcome, 'published', linted.status);
    const e104 = lintShown(SUITE()).find(d => d.code === 'E104');
    assert.ok(e104, 'E104 is shown');
    assert.strictEqual(doc.getText(e104!.range), 'demo.farewell');
    const fixes = await codeActions(doc.uri, e104!.range.start);
    const fix = fixes.find(a => a.title === 'Declare action demo.farewell');
    assert.ok(fix, fixes.map(a => a.title).join(', '));
    const r = await vscode.commands.executeCommand<ScaffoldResult>(fix!.command!.command, ...(fix!.command!.arguments ?? []));
    assert.ok(r.ok, r.message);
    assert.strictEqual(r.generator, 'exit 0', 'the schema generator ran');

    const catalog = read(CATALOG());
    assert.match(catalog, /- name: demo\.farewell\n {4}summary: TODO describe demo\.farewell\.\n {4}bindings: \[powershell\]/);
    assert.match(catalog, /- \{ name: name, type: string \}/);
    assert.match(catalog, /- \{ name: loud, type: boolean \}/);
    assert.match(read(PS('DemoFarewell')), /Register-SuiteAction -Name 'demo\.farewell' -Handler \{/);
    assert.ok(JSON.parse(read(at('test', 'e2e', 'schema', 'suite.schema.json'))).$defs['step.demo.farewell'], 'the schema has a branch for the new action');

    const relinted = await lintSettled(SUITE());
    assert.strictEqual(relinted.outcome, 'published');
    assert.deepStrictEqual(lintShown(SUITE()).map(d => d.code), [], 'E104 is gone');
    console.log(`      ${r.message}`);
    show('generated catalog entry:', excerpt(catalog, '- name: demo.farewell', 8));
    show('generated scripts/e2e/actions/DemoFarewell.ps1:', excerpt(read(PS('DemoFarewell')), 'Register-SuiteAction', 5));
  });

  it('code generation 2: Implement demo.farewell in C#, Go, Rust and TypeScript adds a registration and a handler stub to each', async () => {
    // The index reloads the edited catalog and the new PowerShell file from their file watchers.
    await within(10_000, () => !!api.indexers[0].index.catalog?.actions.has('demo.farewell') && sitesOf('demo.farewell').includes('powershell'));
    const doc = await open(SUITE());
    const offered = (await codeActions(doc.uri, find(doc, 'action: demo.farewell', 10))).map(a => a.title).filter(t => t.startsWith('Implement'));
    assert.deepStrictEqual(offered.sort(), ['Implement demo.farewell in C#', 'Implement demo.farewell in Go', 'Implement demo.farewell in Rust', 'Implement demo.farewell in TypeScript'],
      'offered for each binding with a stub template that does not have it yet');
    for (const binding of ['go', 'rust', 'csharp', 'typescript']) {
      const r = await vscode.commands.executeCommand<ScaffoldResult>('bddSuite.implementAction', 'demo.farewell', binding);
      assert.ok(r.ok, r.message);
      console.log(`      ${r.message}`);
    }
    const go = read(GO());
    assert.match(go, /\{Name: "demo\.farewell", Handler: demoFarewell\},/);
    assert.match(go, /func demoFarewell\(request \*actions\.Request\) \(any, error\) \{\n\treturn nil, actions\.Failed\("demo\.farewell: not implemented in the Go binding yet"\)/);
    const rust = read(RUST());
    assert.match(rust, /Action::new\("demo\.farewell", demo_farewell\),/);
    assert.match(rust, /fn demo_farewell\(_request: &Request\) -> Outcome \{/);
    assert.ok(rust.indexOf('fn demo_farewell') < rust.indexOf('#[cfg(test)]'), 'the Rust handler goes before the tests');
    const cs = read(CSHARP());
    assert.match(cs, /new ActionRegistration\("demo\.farewell", DemoFarewell\),/);
    assert.match(cs, /private static object\? DemoFarewell\(ActionRequest request\) =>/);
    const ts = read(TS());
    assert.match(ts, /action\('demo\.farewell', demoFarewell\),\n\];/);
    assert.match(ts, /async function demoFarewell\(_request: Request\): Promise<never> \{\n {2}throw failed\('demo\.farewell: not implemented in the TypeScript binding yet'\);/);
    assert.match(read(CATALOG()), /- name: demo\.farewell[\s\S]*?bindings: \[powershell, csharp, go, rust, typescript\]/);
    show('generated in actions.go:', [...excerpt(go, '"demo.farewell"', 1), ...excerpt(go, 'func demoFarewell', 3)]);
    show('generated in actions.rs:', [...excerpt(rust, 'Action::new("demo.farewell"', 1), ...excerpt(rust, 'fn demo_farewell', 3)]);
    show('generated in Actions.cs:', [...excerpt(cs, 'ActionRegistration("demo.farewell"', 1), ...excerpt(cs, 'DemoFarewell(ActionRequest', 2)]);
    show('generated in actions.ts:', [...excerpt(ts, "action('demo.farewell'", 1), ...excerpt(ts, 'async function demoFarewell', 3)]);
  });

  it('navigation reaches the generated code: Go to Definition on `action: demo.farewell`, and Find References back from the new Go line', async () => {
    await within(10_000, () => sitesOf('demo.farewell').length === 5);
    const doc = await open(SUITE());
    const found = await describeAll(await definitions(doc.uri, find(doc, 'action: demo.farewell', 'action: '.length + 2)));
    assert.strictEqual(found.length, 6, found.join('\n'));
    for (const where of ['actions.catalog.yaml', 'DemoFarewell.ps1', 'actions.go', 'actions.rs', 'Suite.Cli/Actions.cs', 'actions.ts']) {
      assert.ok(found.some(f => f.includes(where)), `${where} in\n${found.join('\n')}`);
    }
    const go = await open(GO());
    const back = await describeAll(await references(go.uri, find(go, '"demo.farewell"', 3)));
    assert.deepStrictEqual(back, ['test/e2e/suites/demo.yml:23  action: demo.farewell']);
    show('Go to Definition on demo.farewell (generated):', found);
    show('Find References from the generated Go registration:', back);
  });

  it('Go to Implementations (Ctrl+F12) on `action: demo.greet` lists each language\'s registration line', async () => {
    const doc = await open(SUITE());
    const found = await describeAll(await implementations(doc.uri, find(doc, 'action: demo.greet', 'action: '.length + 2)));
    assert.deepStrictEqual(found, [
      "scripts/e2e/actions/DemoGreet.ps1:5  Register-SuiteAction -Name 'demo.greet' -Handler {",
      'test/e2e/bindings/dotnet/Suite.Cli/Actions.cs:13  new ActionRegistration("demo.greet", DemoGreet),',
      'test/e2e/bindings/go/actions/actions.go:15  {Name: "demo.greet", Handler: demoGreet},',
      'test/e2e/bindings/rust/src/actions.rs:9  Action::new("demo.greet", demo_greet),',
      "test/e2e/bindings/typescript/src/actions.ts:5  action('demo.greet', demoGreet),",
    ]);
    show('Go to Implementations (Ctrl+F12) on demo.greet:', found);
  });

  it('C#, two-way through a library: orders.yml to the place-order meta step, to orders.create, to the OrdersCreate method, and back', async () => {
    const orders = await open(ORDERS());
    const meta = await describeAll(await definitions(orders.uri, find(orders, 'meta: place-order', 'meta: '.length + 2)));
    assert.deepStrictEqual(meta, ['test/e2e/suites/_lib/orders-steps.yml:2  - name: place-order']);
    const lib = await open(LIBRARY());
    const impl = await describeAll(await definitions(lib.uri, find(lib, 'action: orders.create', 'action: '.length + 2)));
    assert.ok(impl.includes('test/e2e/bindings/dotnet/Suite.Cli/Actions.cs:22  private static object? OrdersCreate(ActionRequest request)'), impl.join('\n'));

    const cs = await open(CSHARP());
    const method = find(cs, 'OrdersCreate(ActionRequest', 3);
    const back = await describeAll(await references(cs.uri, method));
    assert.deepStrictEqual(back, ['test/e2e/suites/_lib/orders-steps.yml:9  action: orders.create']);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', cs.uri, 100);
    const onMethod = lenses.find(l => l.range.start.line === method.line);
    assert.strictEqual(onMethod?.command?.title, '1 suite step', 'a CodeLens on the method itself');
    show('orders.yml `meta: place-order`, Go to Definition:', meta);
    show('_lib/orders-steps.yml `action: orders.create`, Go to Definition (Ctrl+click):', impl);
    show('Actions.cs, Find References on the OrdersCreate method:', back);
    console.log(`      CodeLens on the OrdersCreate method: "${onMethod!.command!.title}"`);
  });

  it('C# code generation for a declared action: the lightbulb on `action: orders.ship` implements it in C#, and navigation goes both ways', async () => {
    const orders = await open(ORDERS());
    const pos = find(orders, 'action: orders.ship', 10);
    const offered = (await codeActions(orders.uri, pos)).filter(a => a.title.startsWith('Implement'));
    assert.deepStrictEqual(offered.map(a => a.title).sort(),
      ['Implement orders.ship in C#', 'Implement orders.ship in Go', 'Implement orders.ship in Rust', 'Implement orders.ship in TypeScript']);
    const csharp = offered.find(a => a.title === 'Implement orders.ship in C#')!;
    const r = await vscode.commands.executeCommand<ScaffoldResult>(csharp.command!.command, ...(csharp.command!.arguments ?? []));
    assert.ok(r.ok, r.message);
    const text = read(CSHARP());
    assert.match(text, /new ActionRegistration\("orders\.ship", OrdersShip\),/);
    assert.match(text, /private static object\? OrdersShip\(ActionRequest request\) =>\r?\n\s+throw ActionException\.Failed\("orders\.ship: not implemented in the C# binding yet"\);/);
    assert.match(read(CATALOG()), /- name: orders\.ship[\s\S]*?bindings: \[powershell, csharp\]/);

    await within(10_000, () => api.indexers[0].index.sitesFor('orders.ship').some(s => s.binding === 'csharp' && !!s.handlerRange));
    const impl = await describeAll(await definitions(orders.uri, pos));
    const generated = impl.find(l => l.includes('Suite.Cli/Actions.cs'));
    assert.match(generated ?? '', /Actions\.cs:\d+ {2}private static object\? OrdersShip\(ActionRequest request\) =>/);
    const cs = await open(CSHARP());
    const back = await describeAll(await references(cs.uri, find(cs, 'OrdersShip(ActionRequest', 3)));
    assert.deepStrictEqual(back, ['test/e2e/suites/orders.yml:10  action: orders.ship']);
    console.log(`      ${r.message}`);
    show('generated in Actions.cs:', [...excerpt(text, 'ActionRegistration("orders.ship"', 1), ...excerpt(text, 'OrdersShip(ActionRequest', 2)]);
    show('Go to Definition (Ctrl+click) on orders.ship now:', impl);
    show('Find References on the generated OrdersShip method:', back);
  });

  it('C# code generation for an undeclared action: E104 on orders.refund, Declare action, Implement in C#, then both ways', async () => {
    const orders = await open(ORDERS());
    const linted = await lintSettled(ORDERS());
    assert.strictEqual(linted.outcome, 'published', linted.status);
    const e104 = lintShown(ORDERS()).find(d => d.code === 'E104');
    assert.strictEqual(e104 && orders.getText(e104.range), 'orders.refund');
    const declare = (await codeActions(orders.uri, e104!.range.start)).find(a => a.title === 'Declare action orders.refund')!;
    const declared = await vscode.commands.executeCommand<ScaffoldResult>(declare.command!.command, ...(declare.command!.arguments ?? []));
    assert.ok(declared.ok, declared.message);
    assert.match(read(CATALOG()), /- name: orders\.refund[\s\S]*?- \{ name: orderId, type: string \}  # TODO type[\s\S]*?- \{ name: amount, type: number \}/,
      'the parameter types come from the step; a ${...} value is marked TODO');

    await within(10_000, () => !!api.indexers[0].index.catalog?.actions.has('orders.refund') && sitesOf('orders.refund').includes('powershell'));
    const pos = find(orders, 'action: orders.refund', 10);
    const csharp = (await codeActions(orders.uri, pos)).find(a => a.title === 'Implement orders.refund in C#')!;
    const implemented = await vscode.commands.executeCommand<ScaffoldResult>(csharp.command!.command, ...(csharp.command!.arguments ?? []));
    assert.ok(implemented.ok, implemented.message);
    await within(10_000, () => api.indexers[0].index.sitesFor('orders.refund').some(s => s.binding === 'csharp' && !!s.handlerRange));

    const impl = await describeAll(await definitions(orders.uri, pos));
    assert.ok(impl.some(l => /Suite\.Cli\/Actions\.cs:\d+ {2}private static object\? OrdersRefund\(ActionRequest request\) =>/.test(l)), impl.join('\n'));
    const cs = await open(CSHARP());
    const back = await describeAll(await references(cs.uri, find(cs, 'OrdersRefund(ActionRequest', 3)));
    assert.deepStrictEqual(back, ['test/e2e/suites/orders.yml:18  action: orders.refund']);
    assert.deepStrictEqual(lintShown(ORDERS()).length, 1, 'still the E104 from before the declaration until the next lint');
    assert.strictEqual((await lintSettled(ORDERS())).outcome, 'published');
    assert.deepStrictEqual(lintShown(ORDERS()), [], 'and the next lint clears it');
    console.log(`      ${declared.message}`);
    console.log(`      ${implemented.message}`);
    show('generated catalog entry:', excerpt(read(CATALOG()), '- name: orders.refund', 9));
    show('generated in Actions.cs:', [...excerpt(read(CSHARP()), 'ActionRegistration("orders.refund"', 1), ...excerpt(read(CSHARP()), 'OrdersRefund(ActionRequest', 2)]);
    show('Go to Definition (Ctrl+click) on orders.refund:', impl);
    show('Find References on the generated OrdersRefund method:', back);
  });

  it('assistance, applied: the CodeLens "Implement in C#" on demo.count generates the C# method, and the lens then names what is left', async () => {
    const doc = await open(SUITE());
    const line = find(doc, 'action: demo.count').line;
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri, 100);
    const csharp = lenses.find(l => l.range.start.line === line && l.command?.title === '$(add) Implement in C#')!;
    const r = await vscode.commands.executeCommand<ScaffoldResult>(csharp.command!.command, ...(csharp.command!.arguments ?? []));
    assert.ok(r.ok, r.message);
    assert.match(read(CSHARP()), /private static object\? DemoCount\(ActionRequest request\) =>/);
    await within(10_000, () => sitesOf('demo.count').includes('csharp'));
    let titles: (string | undefined)[] = [];
    await within(10_000, async () => {
      titles = (await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri, 100))
        .filter(l => l.range.start.line === line).map(l => l.command?.title);
      return titles[0] === 'Not implemented in Rust, TypeScript';
    });
    assert.deepStrictEqual(titles, ['Not implemented in Rust, TypeScript', '$(add) Implement in Rust', '$(add) Implement in TypeScript']);
    const found = await describeAll(await definitions(doc.uri, find(doc, 'action: demo.count', 10)));
    assert.ok(found.some(f => /Suite\.Cli\/Actions\.cs:\d+ {2}private static object\? DemoCount\(ActionRequest request\) =>/.test(f)), found.join('\n'));
    console.log(`      ${r.message}`);
    show('CodeLens above `action: demo.count` now:', titles.map(String));
  });

  it('a newer copy installed while the window is open is offered as a reload (status bar button and notification)', async () => {
    const ext = vscode.extensions.getExtension('asz.bdd-suite')!;
    const newer = path.join(path.dirname(ext.extensionPath), 'asz.bdd-suite-99.0.0');
    fs.mkdirSync(newer, { recursive: true });
    try {
      fs.writeFileSync(path.join(newer, 'package.json'), JSON.stringify({ name: 'bdd-suite', publisher: 'asz', version: '99.0.0' }));
      const line = `Suite Authoring 99.0.0 is installed; this window runs ${ext.packageJSON.version} until it reloads.`;
      await within(15_000, () => api.log.includes(line));
      show('after a newer copy appeared in the extensions folder:', [line]);
    } finally {
      fs.rmSync(newer, { recursive: true, force: true });
    }
  });

  it('the binding table shows every binding with what it declares and registers, and no drift', () => {
    const rows = api.coverage.rows();
    for (const r of rows) assert.deepStrictEqual([r.declaredNotFound, r.foundNotDeclared, r.duplicates], [[], [], []], r.binding);
    show('binding table:', rows.map(r => `${r.label}: ${r.declared.length} declared, ${r.found.length} found, 0 drift`));
  });
});
