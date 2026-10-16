// B5.1-B5.4, S5a.4: names, templates and the registry anchors, on registry
// files in the DEC-S11 layout, written as each language's formatter leaves them.
import * as assert from 'assert';
import * as fs from 'fs';
import { test } from 'node:test';
import * as path from 'path';
import {
  alignEntry, camelName, pascalName, planStub, powershellStubFile, renderTemplate, snakeName, stubTarget, templateSections,
} from '../../src/core/stubs';

const templates = path.resolve(__dirname, '../../../templates');
const template = (name: string) => fs.readFileSync(path.join(templates, name), 'utf8');

const GO = [
  '// Package actions is the workspace\'s actions.',
  'package actions',
  '',
  'import "github.com/smartpcr/bdd-code-extension/runtimes/go/suite/actions"',
  '',
  '// Registrations is every action the workspace adds.',
  'var Registrations = []actions.Registration{',
  '\t{Name: "demo.greet", Handler: demoGreet},',
  '}',
  '',
  'func demoGreet(request *actions.Request) (any, error) {',
  '\treturn nil, nil',
  '}',
  '',
].join('\n');

const RUST = [
  'use suiterun::actions::{ActionError, Outcome, Request};',
  'use suiterun::Action;',
  '',
  '/// Every action the workspace adds.',
  'pub fn actions() -> Vec<Action> {',
  '    vec![',
  '        Action::new("demo.greet", demo_greet),',
  '    ]',
  '}',
  '',
  'fn demo_greet(_request: &Request) -> Outcome {',
  '    Ok(serde_json::json!({}))',
  '}',
  '',
  '#[cfg(test)]',
  'mod tests {}',
  '',
].join('\n');

const CSHARP = [
  'using Bdd.Suite.Actions;',
  'using Bdd.Suite.Extensions;',
  '',
  'namespace Suite.Cli;',
  '',
  'public static class Actions',
  '{',
  '    public static IReadOnlyList<ActionRegistration> All { get; } =',
  '    [',
  '        new ActionRegistration("demo.greet", DemoGreet),',
  '    ];',
  '',
  '    private static object? DemoGreet(ActionRequest request)',
  '    {',
  '        return null;',
  '    }',
  '}',
  '',
].join('\r\n');

const TYPESCRIPT = [
  "import { action, failed, type Registration, type Request } from '@bdd-suite/runtime';",
  '',
  'export const registrations: readonly Registration[] = [',
  "  action('demo.greet', demoGreet),",
  '];',
  '',
  'async function demoGreet(request: Request) {',
  '  return request.step;',
  '}',
].join('\n');

const apply = (text: string, edits: { start: number; end: number; text: string }[]) =>
  [...edits].sort((a, b) => b.start - a.start).reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);

function implement(binding: string, action: string, text: string, over: Partial<Parameters<typeof planStub>[0]> = {}) {
  const target = stubTarget(binding)!;
  const plan = planStub({ binding, action, file: 'C:/r/' + target.file, text, template: template(target.template), hasSite: false, ...over });
  if ('refused' in plan) return plan;
  assert.ok(plan.edits.every(e => e.file === 'C:/r/' + target.file && e.start === e.end));
  return { out: apply(text, plan.edits) };
}

test('names: Pascal for C# and PowerShell files, camel for Go and TypeScript, snake for Rust', () => {
  assert.deepStrictEqual([pascalName('demo.echo'), camelName('demo.echo'), snakeName('demo.echo')], ['DemoEcho', 'demoEcho', 'demo_echo']);
  assert.deepStrictEqual([pascalName('orders.streamWait'), camelName('orders.streamWait'), snakeName('orders.streamWait')],
    ['OrdersStreamWait', 'ordersStreamWait', 'orders_stream_wait']);
  assert.strictEqual(powershellStubFile('demo.echo'), 'scripts/e2e/actions/DemoEcho.ps1');
});

test('S5a.4 one target per language in the DEC-S11 layout; PowerShell has its own file, not a registry', () => {
  assert.deepStrictEqual(['go', 'rust', 'csharp', 'typescript'].map(b => [stubTarget(b)!.file, stubTarget(b)!.template]), [
    ['test/e2e/bindings/go/actions/actions.go', 'go.tmpl'],
    ['test/e2e/bindings/rust/src/actions.rs', 'rust.tmpl'],
    ['test/e2e/bindings/dotnet/Suite.Cli/Actions.cs', 'csharp.tmpl'],
    ['test/e2e/bindings/typescript/src/actions.ts', 'typescript.tmpl'],
  ]);
  assert.strictEqual(stubTarget('powershell'), undefined);
  assert.strictEqual(stubTarget('constructor'), undefined, 'only the table\'s own entries');
  assert.match(template('powershell.ps1.tmpl'), /^Register-SuiteAction -Name '\{\{action\}\}' -Handler \{$/m);
});

test('renderTemplate and templateSections', () => {
  assert.strictEqual(renderTemplate('{{action}} {{goName}} {{tsName}} {{rustName}} {{pascalName}} {{unknown}}', 'a.bC'),
    'a.bC aBC aBC a_b_c ABC {{unknown}}');
  const s = templateSections('ignored\r\n@@ one\r\nx\r\n\r\n@@ two\r\ny\r\n');
  assert.deepStrictEqual([...s], [['one', 'x'], ['two', 'y']]);
  assert.strictEqual(templateSections('no sections').size, 0);
});

test('alignEntry keeps gofmt\'s value column when it fits, else one space', () => {
  assert.strictEqual(alignEntry('"a.b": x,', '\t\t"core.noop":   noop,'), '"a.b":         x,');
  assert.strictEqual(alignEntry('"a.very.long.name": x,', '\t\t"core.noop":   noop,'), '"a.very.long.name": x,');
  assert.strictEqual(alignEntry('{Name: "a", Handler: a},', '\t{Name: "b", Handler: b},'), '{Name: "a", Handler: a},');
  assert.strictEqual(alignEntry('"a.b": x,', '}'), '"a.b": x,');
});

test('B5.2 Go: an entry in Registrations and a stub using the runtime\'s actions package at the end of the file', () => {
  const r = implement('go', 'demo.echo', GO);
  assert.ok('out' in r);
  assert.match(r.out, /\t\{Name: "demo\.greet", Handler: demoGreet\},\n\t\{Name: "demo\.echo", Handler: demoEcho\},\n\}/);
  assert.ok(r.out.endsWith('}\n\nfunc demoEcho(request *actions.Request) (any, error) {\n'
    + '\treturn nil, actions.Failed("demo.echo: not implemented in the Go binding yet")\n}\n'));
  const empty = implement('go', 'demo.echo', GO.replace(/\t\{Name: "demo\.greet".*\n/, '').replace(/\n$/, ''));
  assert.ok('out' in empty);
  assert.match(empty.out, /Registration\{\n\t\{Name: "demo\.echo", Handler: demoEcho\},\n\}/, 'an empty list takes a tab');
  assert.ok(empty.out.endsWith('\treturn nil, nil\n}\n\nfunc demoEcho(request *actions.Request) (any, error) {\n'
    + '\treturn nil, actions.Failed("demo.echo: not implemented in the Go binding yet")\n}\n'), 'no final line break is kept whole');
});

test('B5.3 Rust: an Action::new in the vec! of actions(), the stub above #[cfg(test)]', () => {
  const r = implement('rust', 'demo.echo', RUST);
  assert.ok('out' in r);
  assert.match(r.out, / {8}Action::new\("demo\.greet", demo_greet\),\n {8}Action::new\("demo\.echo", demo_echo\),\n {4}\]/);
  assert.match(r.out, /\n}\n\nfn demo_echo\(_request: &Request\) -> Outcome \{\n {4}Err\(ActionError::action\("demo\.echo: not implemented in the Rust binding yet"\)\)\n\}\n\n#\[cfg\(test\)\]/);
  const noTests = implement('rust', 'demo.echo', RUST.split('#[cfg(test)]')[0].trimEnd());
  assert.ok('out' in noTests && noTests.out.endsWith('}\n\nfn demo_echo(_request: &Request) -> Outcome {\n'
    + '    Err(ActionError::action("demo.echo: not implemented in the Rust binding yet"))\n}\n'));
  const empty = implement('rust', 'demo.echo', RUST.replace(/ {8}Action::new\("demo\.greet".*\n/, ''));
  assert.ok('out' in empty);
  assert.match(empty.out, /vec!\[\n {8}Action::new\("demo\.echo", demo_echo\),\n {4}\]/, 'an empty list takes the closing line\'s indent plus four');
});

test('B5.4 C#: an ActionRegistration in All, a method before the class\'s closing brace, CRLF kept', () => {
  const r = implement('csharp', 'demo.echo', CSHARP);
  assert.ok('out' in r);
  assert.match(r.out, / {8}new ActionRegistration\("demo\.greet", DemoGreet\),\r\n {8}new ActionRegistration\("demo\.echo", DemoEcho\),\r\n {4}\];/);
  assert.match(r.out, / {8}return null;\r\n {4}\}\r\n\r\n {4}private static object\? DemoEcho\(ActionRequest request\) =>\r\n {8}throw ActionException\.Failed\("demo\.echo: not implemented in the C# binding yet"\);\r\n\}\r\n$/);
  assert.ok(!r.out.replace(/\r\n/g, '').includes('\n'), 'every line break is CRLF');
});

test('S5a.4 TypeScript: an action() in registrations, an async stub that throws failed() at the end of the file', () => {
  const r = implement('typescript', 'demo.echo', TYPESCRIPT);
  assert.ok('out' in r);
  assert.match(r.out, / {2}action\('demo\.greet', demoGreet\),\n {2}action\('demo\.echo', demoEcho\),\n\];/);
  assert.ok(r.out.endsWith('  return request.step;\n}\n\nasync function demoEcho(_request: Request): Promise<never> {\n'
    + "  throw failed('demo.echo: not implemented in the TypeScript binding yet');\n}\n"));
  const empty = implement('typescript', 'demo.echo', TYPESCRIPT.replace(/ {2}action\('demo\.greet'.*\n/, ''));
  assert.ok('out' in empty);
  assert.match(empty.out, /= \[\n {2}action\('demo\.echo', demoEcho\),\n\];/, 'an empty list takes the file\'s two spaces');
  const bare = implement('typescript', 'demo.echo', 'export const registrations = [\n];\n');
  assert.ok('out' in bare);
  assert.match(bare.out, /^export const registrations = \[\n {4}action\('demo\.echo', demoEcho\),\n\];\n/, 'four spaces when nothing is indented yet');
});

test('a workspace template (bddSuite.templatesDir) replaces the shipped one; its blank lines stay unindented', () => {
  const own = '@@ registration\nnew ActionRegistration("{{action}}", {{pascalName}}),\n@@ handler\n// {{action}}\n\nprivate static object? {{pascalName}}(ActionRequest request) => null;\n';
  const r = implement('csharp', 'demo.echo', CSHARP, { template: own });
  assert.ok('out' in r);
  assert.match(r.out, /\r\n {4}\/\/ demo\.echo\r\n\r\n {4}private static object\? DemoEcho\(ActionRequest request\) => null;\r\n\}/);
});

test('refusals: no template, a site already there, a name already declared, a missing section, each missing anchor', () => {
  const r = (binding: string, action: string, text: string, over = {}) => (implement(binding, action, text, over) as { refused: string }).refused;
  assert.match((planStub({ binding: 'powershell', action: 'a.b', file: 'f', text: '', template: '', hasSite: false }) as { refused: string }).refused,
    /no stub template for the powershell binding/);
  assert.match(r('go', 'demo.greet', GO, { hasSite: true }), /already registered in the go binding/);
  assert.match(r('go', 'demo.echo', GO + 'func demoEcho(x int) {}\n'), /already declares `demoEcho`/);
  assert.match(r('rust', 'demo.echo', RUST + 'pub fn demo_echo() {}\n'), /already declares `demo_echo`/);
  assert.match(r('csharp', 'demo.echo', CSHARP + '    object? DemoEcho(ActionRequest r) => null;'), /already declares `DemoEcho`/);
  assert.match(r('typescript', 'demo.echo', TYPESCRIPT + '\nexport async function demoEcho() {}\n'), /already declares `demoEcho`/);
  assert.match(r('rust', 'demo.echo', RUST, { template: '@@ handler\nx' }), /has no `@@ registration` section/);
  assert.match(r('go', 'demo.echo', 'package actions\n'), /`var Registrations = \[\]actions\.Registration\{` was not found; the template needs updating/);
  assert.match(r('go', 'demo.echo', 'var Registrations = []actions.Registration{\n'), /the closing `}` was not found/);
  assert.match(r('rust', 'demo.echo', 'fn other() {}\n'), /the `vec!\[` list in `fn actions\(\)` was not found/);
  assert.match(r('rust', 'demo.echo', 'pub fn actions() -> Vec<Action> {\n    Vec::new()\n}\n\nfn x() {\n    vec![\n    ]\n}\n'), /`vec!\[` list/,
    'a vec! after actions() is not its list');
  assert.match(r('rust', 'demo.echo', 'pub fn actions() -> Vec<Action> {\n    vec![\n'), /`vec!\[` list/, 'no end to actions()');
  assert.match(r('csharp', 'demo.echo', 'class X {}\n'), /`All \{ get; \} =` was not found/);
  assert.match(r('csharp', 'demo.echo', CSHARP.replace(/\r\n}\r\n$/, '\r\n')), /class's closing brace/);
  assert.match(r('csharp', 'demo.echo', CSHARP.replace('    ];', '    ]')), /the closing `];` was not found/);
  assert.match(r('typescript', 'demo.echo', 'export const other = [\n];\n'), /`export const registrations = \[` was not found/);
});
