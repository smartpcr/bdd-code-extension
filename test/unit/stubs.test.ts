// B5.1-B5.4: names, templates and the registry anchors, on excerpts of the
// real registry files that keep each anchor's surroundings as they are.
import * as assert from 'assert';
import * as fs from 'fs';
import { test } from 'node:test';
import * as path from 'path';
import {
  alignEntry, camelName, pascalName, planStub, powershellStubFile, renderTemplate, snakeName, stubTarget, templateSections,
} from '../../src/core/stubs';

const templates = path.resolve(__dirname, '../../../templates');
const template = (name: string) => fs.readFileSync(path.join(templates, name), 'utf8');

const GO_CORE = [
  'package actions',
  '',
  '// Registry is every core action.',
  'func Registry() map[string]Handler {',
  '\treturn map[string]Handler{',
  '\t\t"core.noop":   noop,',
  '\t\t"core.record": record,',
  '\t}',
  '}',
  '',
  'func noop(request *Request) (any, error) {',
  '\treturn nil, nil',
  '}',
  '',
].join('\n');

const GO_LIFECYCLE = [
  'package lifecycle',
  '',
  'var handlers = map[string]handler{',
  '\t"lifecycle.get":              get,',
  '\t"lifecycle.compareOperation": compareOperation,',
  '}',
  '',
  'func get(held *Context, request *actions.Request) (any, error) {',
  '\treturn nil, nil',
  '}',
].join('\n');

const RUST_CORE = [
  'pub fn registry() -> BTreeMap<&\'static str, Handler> {',
  '    let mut map: BTreeMap<&\'static str, Handler> = BTreeMap::new();',
  '    map.insert("core.noop", core_noop);',
  '    map.insert("core.record", core_record);',
  '    map',
  '}',
  '',
  'fn core_noop(_request: &Request) -> Outcome {',
  '    Ok(json!({}))',
  '}',
  '',
  '#[cfg(test)]',
  'mod tests {}',
  '',
].join('\n');

const RUST_LIFECYCLE = [
  'pub fn names() -> Vec<&\'static str> {',
  '    vec![',
  '        "lifecycle.cleanup",',
  '        "lifecycle.events",',
  '        "lifecycle.get",',
  '    ]',
  '}',
  '',
  'pub fn dispatch(name: &str, context: &Shared, step: &Value) -> Result<Value, ActionError> {',
  '    match name {',
  '        "lifecycle.get" => get(context, step),',
  '        other => Err(ActionError::action(format!("Unknown action: {other}"))),',
  '    }',
  '}',
  '',
  '#[cfg(test)]',
  'mod tests {}',
  '',
].join('\n');

const CSHARP_CORE = [
  'namespace Hci.E2E.Suite.Actions;',
  '',
  'public sealed class ActionException(string message) : Exception(message)',
  '{',
  '}',
  '',
  'public static class CoreActions',
  '{',
  '    public static IReadOnlyDictionary<string, Func<ActionRequest, object?>> Registry { get; } =',
  '        new Dictionary<string, Func<ActionRequest, object?>>(StringComparer.Ordinal)',
  '        {',
  '            ["core.noop"] = Noop,',
  '        };',
  '',
  '    private static object? Noop(ActionRequest request)',
  '    {',
  '        return null;',
  '    }',
  '}',
  '',
].join('\r\n');

const CSHARP_LIFECYCLE = [
  'namespace Hci.E2E.Suite.Actions.Lifecycle;',
  '',
  'public sealed partial class LifecycleContext',
  '{',
  '    private delegate object? Handler(LifecycleContext context, ActionRequest request);',
  '',
  '    private static readonly Dictionary<string, Handler> Handlers = new(StringComparer.Ordinal)',
  '    {',
  '        ["lifecycle.get"] = (context, request) => context.Get(request),',
  '    };',
  '',
  '    private object? Get(ActionRequest request) => null;',
  '}',
].join('\n');

const apply = (text: string, edits: { start: number; end: number; text: string }[]) =>
  [...edits].sort((a, b) => b.start - a.start).reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);

function implement(binding: string, action: string, text: string, over: Partial<Parameters<typeof planStub>[0]> = {}) {
  const target = stubTarget(binding, action)!;
  const plan = planStub({ binding, action, file: 'C:/r/' + target.file, text, template: template(target.template), hasSite: false, ...over });
  if ('refused' in plan) return plan;
  assert.ok(plan.edits.every(e => e.file === 'C:/r/' + target.file && e.start === e.end));
  return { out: apply(text, plan.edits) };
}

test('names: Pascal for C# and PowerShell files, camel for Go and TypeScript, snake for Rust', () => {
  assert.deepStrictEqual([pascalName('demo.echo'), camelName('demo.echo'), snakeName('demo.echo')], ['DemoEcho', 'demoEcho', 'demo_echo']);
  assert.deepStrictEqual([pascalName('lifecycle.streamWait'), camelName('lifecycle.streamWait'), snakeName('lifecycle.streamWait')],
    ['LifecycleStreamWait', 'lifecycleStreamWait', 'lifecycle_stream_wait']);
  assert.strictEqual(powershellStubFile('demo.echo'), 'scripts/e2e/actions/DemoEcho.ps1');
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
  assert.strictEqual(alignEntry('["a"] = X,', '["b"] = Y,'), '["a"] = X,');
  assert.strictEqual(alignEntry('"a.b": x,', '}'), '"a.b": x,');
});

test('B5.2 Go core: a map entry in Registry() and a stub at the end of the file', () => {
  const r = implement('go', 'demo.echo', GO_CORE);
  assert.ok('out' in r);
  assert.match(r.out, /\t\t"core\.record": record,\n\t\t"demo\.echo":   demoEcho,\n\t\}/);
  assert.ok(r.out.endsWith('}\n\nfunc demoEcho(request *Request) (any, error) {\n\treturn nil, Failed("demo.echo: not implemented in the Go binding yet")\n}\n'));
});

test('B5.2 Go lifecycle: an entry in handlers, a stub with the lifecycle signature; no final line break is kept whole', () => {
  const r = implement('go', 'lifecycle.demo', GO_LIFECYCLE);
  assert.ok('out' in r);
  assert.match(r.out, /\t"lifecycle\.demo":             lifecycleDemo,\n\}/);
  assert.ok(r.out.endsWith('\treturn nil, nil\n}\n\nfunc lifecycleDemo(context *Context, request *actions.Request) (any, error) {\n\treturn nil, actions.Failed("lifecycle.demo: not implemented in the Go binding yet")\n}\n'));
});

test('B5.3 Rust core: after the last map.insert, the stub above #[cfg(test)]', () => {
  const r = implement('rust', 'demo.echo', RUST_CORE);
  assert.ok('out' in r);
  assert.match(r.out, /map\.insert\("core\.record", core_record\);\n {4}map\.insert\("demo\.echo", demo_echo\);\n {4}map\n/);
  assert.match(r.out, /\n}\n\nfn demo_echo\(_request: &Request\) -> Outcome \{\n {4}Err\(ActionError::action\("demo\.echo: not implemented in the Rust binding yet"\.to_string\(\)\)\)\n\}\n\n#\[cfg\(test\)\]/);
  const noTests = implement('rust', 'demo.echo', RUST_CORE.split('#[cfg(test)]')[0].trimEnd());
  assert.ok('out' in noTests && noTests.out.endsWith('}\n\nfn demo_echo(_request: &Request) -> Outcome {\n    Err(ActionError::action("demo.echo: not implemented in the Rust binding yet".to_string()))\n}\n'));
});

test('B5.3 Rust lifecycle: names() in sorted position, an arm before the catch-all, the stub above #[cfg(test)]', () => {
  const r = implement('rust', 'lifecycle.demo', RUST_LIFECYCLE);
  assert.ok('out' in r);
  assert.match(r.out, /"lifecycle\.cleanup",\n {8}"lifecycle\.demo",\n {8}"lifecycle\.events",/);
  assert.match(r.out, /=> get\(context, step\),\n {8}"lifecycle\.demo" => lifecycle_demo\(context, step\),\n {8}other =>/);
  assert.match(r.out, /\npub fn lifecycle_demo\(_context: &Shared, _step: &Value\) -> Result<Value, ActionError> \{\n.*\n\}\n\n#\[cfg\(test\)\]/);
  const last = implement('rust', 'lifecycle.zzz', RUST_LIFECYCLE.replace('        other => Err(ActionError::action(format!("Unknown action: {other}"))),\n', ''));
  assert.ok('out' in last);
  assert.match(last.out, /"lifecycle\.get",\n {8}"lifecycle\.zzz",\n {4}\]/, 'after the last name');
  assert.match(last.out, /=> get\(context, step\),\n {8}"lifecycle\.zzz" => lifecycle_zzz\(context, step\),\n {4}\}/, 'before the closing brace with no catch-all');
  const empty = implement('rust', 'lifecycle.a', RUST_LIFECYCLE.replace(/ {8}"lifecycle\.(cleanup|events|get)",\n/g, ''));
  assert.ok('out' in empty);
  assert.match(empty.out, /vec!\[\n {8}"lifecycle\.a",\n {4}\]/);
});

test('B5.4 C# core: an entry in Registry, a method before the class\'s closing brace, CRLF kept', () => {
  const r = implement('csharp', 'demo.echo', CSHARP_CORE);
  assert.ok('out' in r);
  assert.match(r.out, / {12}\["core\.noop"\] = Noop,\r\n {12}\["demo\.echo"\] = DemoEcho,\r\n {8}\};/);
  assert.match(r.out, / {8}return null;\r\n {4}\}\r\n\r\n {4}private static object\? DemoEcho\(ActionRequest request\) =>\r\n {8}throw ActionException\.Failed\("demo\.echo: not implemented in the C# binding yet"\);\r\n\}\r\n$/);
  assert.ok(!r.out.replace(/\r\n/g, '').includes('\n'), 'every line break is CRLF');
});

test('a workspace template (bddSuite.templatesDir) replaces the shipped one; its blank lines stay unindented', () => {
  const own = '@@ registration\n["{{action}}"] = {{pascalName}},\n@@ handler\n// {{action}}\n\nprivate static object? {{pascalName}}(ActionRequest request) => null;\n';
  const r = implement('csharp', 'demo.echo', CSHARP_CORE, { template: own });
  assert.ok('out' in r);
  assert.match(r.out, /\r\n {4}\/\/ demo\.echo\r\n\r\n {4}private static object\? DemoEcho\(ActionRequest request\) => null;\r\n\}/);
});

test('B5.4 C# lifecycle: an entry calling the context method, the method inside LifecycleContext', () => {
  const r = implement('csharp', 'lifecycle.demo', CSHARP_LIFECYCLE);
  assert.ok('out' in r);
  assert.match(r.out, /\["lifecycle\.demo"\] = \(context, request\) => context\.LifecycleDemo\(request\),\n {4}\};/);
  assert.match(r.out, /=> null;\n\n {4}private object\? LifecycleDemo\(ActionRequest request\) =>\n {8}throw .*\n\}$/);
  const emptyDict = implement('csharp', 'lifecycle.demo', CSHARP_LIFECYCLE.replace(/ {8}\["lifecycle\.get"\].*\n/, ''));
  assert.ok('out' in emptyDict);
  assert.match(emptyDict.out, /\{\n {8}\["lifecycle\.demo"\]/, 'an empty dictionary takes the closing line\'s indent plus four');
  const tabs = implement('go', 'demo.echo', GO_CORE.replace(/\t\t"core\.(noop|record)".*\n/g, ''));
  assert.ok('out' in tabs);
  assert.match(tabs.out, /return map\[string\]Handler\{\n\t\t"demo\.echo": demoEcho,\n\t\}/, 'an empty Go map takes a tab');
});

test('refusals: no template, a site already there, a name already declared, a missing section, each missing anchor', () => {
  const r = (binding: string, action: string, text: string, over = {}) => (implement(binding, action, text, over) as { refused: string }).refused;
  assert.strictEqual(stubTarget('typescript', 'demo.echo'), undefined);
  assert.strictEqual(planStub({ binding: 'typescript', action: 'a.b', file: 'f', text: '', template: '', hasSite: false }).hasOwnProperty('refused'), true);
  assert.match(r('go', 'core.noop', GO_CORE, { hasSite: true }), /already registered in the go binding/);
  assert.match(r('go', 'demo.echo', GO_CORE + 'func demoEcho(x int) {}\n'), /already declares `demoEcho`/);
  assert.match(r('rust', 'demo.echo', RUST_CORE, { template: '@@ handler\nx' }), /has no `@@ registration` section/);
  assert.match(r('go', 'demo.echo', 'package actions\n'), /`return map\[string\]Handler\{` was not found; the template needs updating/);
  assert.match(r('go', 'demo.echo', '\treturn map[string]Handler{\n'), /the closing `}` was not found/);
  assert.match(r('rust', 'demo.echo', 'fn other() {}\n'), /`fn registry\(` was not found/);
  assert.match(r('rust', 'demo.echo', 'pub fn registry() {\n    map\n}\n'), /no `map\.insert\(` line/);
  assert.match(r('rust', 'lifecycle.demo', 'fn x() {}\n'), /`vec!\[` list in `names\(\)`/);
  assert.match(r('rust', 'lifecycle.demo', RUST_LIFECYCLE.replace('match name {', 'match other {')), /`match name \{` in `dispatch\(\)`/);
  assert.match(r('rust', 'lifecycle.demo', RUST_LIFECYCLE.replace('pub fn dispatch(', 'pub fn route(')), /`match name \{` in `dispatch\(\)`/);
  assert.match(r('csharp', 'demo.echo', 'class X {}\n'), /`Registry \{ get; \} =` was not found/);
  assert.match(r('csharp', 'demo.echo', CSHARP_CORE.replace('static class CoreActions', 'static class Other')), /class's closing brace/);
  assert.match(r('csharp', 'lifecycle.demo', CSHARP_LIFECYCLE.replace('    };', '    }')), /the closing `};` was not found/);
});
