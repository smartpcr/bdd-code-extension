// B1.4: compileRecognizers, scanRegistrations; B1.4-1 against the real tree.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { minimatch } from 'minimatch';
import { DEFAULT_BINDINGS } from '../../src/config/defaults';
import { parseCatalog } from '../../src/core/catalog';
import { compileRecognizers, findHandlerDeclaration, handlerIdentifier, scanRegistrations } from '../../src/core/registrations';

const scan = (binding: string, text: string) =>
  scanRegistrations(text, `/src.${binding}`, binding, compileRecognizers(DEFAULT_BINDINGS[binding].recognizers).ok);
const names = (binding: string, text: string) => scan(binding, text).map(s => [s.action, s.handler ?? null]);

test('powershell: single and double quotes; commented and near-miss lines are not sites', () => {
  const text = [
    "Register-LabAction -Name 'cluster.resume' -Handler {",
    'Register-LabAction -Name "lifecycle.host" -Handler {',
    "# Register-LabAction -Name 'commented.out' -Handler {",
    "    Register-LabAction  -Name   'wait' -Handler {",
    "Get-LabAction -Name 'not.a.registration'",
  ].join('\n');
  assert.deepStrictEqual(names('powershell', text), [['cluster.resume', null], ['lifecycle.host', null], ['wait', null]]);
});

test('go: map entries and the wait append; near misses', () => {
  const text = [
    '\treturn map[string]Handler{',
    '\t\t"core.noop":   noop,',
    '\t"lifecycle.observations":     bySuffix("lifecycle", false),',
    '\t// "commented.out": x,',
    '\tnames = append(names, "wait")',
    '\t"Content-Type": json,',
    '\tx := "not.a.key"',
  ].join('\n');
  assert.deepStrictEqual(names('go', text),
    [['core.noop', 'noop'], ['lifecycle.observations', 'bySuffix'], ['wait', null]]);
});

test('rust: map.insert, dispatch arm and names.push', () => {
  const text = [
    '    map.insert("core.noop", core_noop);',
    '        "lifecycle.get" => get(context, step),',
    '    names.push("wait".to_string());',
    '        "lifecycle.get",',
    '    // map.insert("commented.out", x);',
    '        "equals" => compare(a, b),',
  ].join('\n');
  assert.deepStrictEqual(names('rust', text), [['core.noop', 'core_noop'], ['lifecycle.get', 'get'], ['wait', null]]);
});

test('csharp: dictionary entries and names.Add', () => {
  const text = [
    '            ["core.noop"] = Noop,',
    '        ["lifecycle.get"] = (context, request) => context.Get(request),',
    '        names.Add("wait");',
    '        // ["commented.out"] = X,',
    '        var x = dict["key"];',
    '        schema["$schema"] = 1;',
  ].join('\n');
  assert.deepStrictEqual(names('csharp', text), [
    ['core.noop', 'Noop'], ['lifecycle.get', '(context, request) => context.Get(request)'], ['wait', null]]);
});

test('typescript: action() registrations, one shape for all including wait', () => {
  const text = [
    'export const coreActions: readonly Registration[] = [',
    "  action('core.noop', noop),",
    "  action('wait', wait),",
    "  // action('commented.out', x),",
    "  transaction('not.this', x),",
    '];',
  ].join('\n');
  assert.deepStrictEqual(names('typescript', text), [['core.noop', 'noop'], ['wait', 'wait']]);
});

test('B1.4-2 the range of a site is the name inside its quotes', () => {
  const text = 'x\n\t\t"core.noop":   noop,\n';
  const [site] = scan('go', text);
  assert.deepStrictEqual(site.range, { start: { line: 1, character: 3 }, end: { line: 1, character: 12 } });
  assert.strictEqual(site.binding, 'go');
  assert.strictEqual(site.file, '/src.go');
  assert.strictEqual(site.recognizer, 0);
});

test('B1.4-4 bad patterns are reported with their setting path; good ones still compile', () => {
  const { ok, errors } = compileRecognizers([
    { pattern: 'no name group' }, { pattern: '(?<name>[unclosed' }, { pattern: "x(?<name>y)", flags: 'gi' },
  ], 'bddSuite.bindings.go.recognizers');
  assert.strictEqual(ok.length, 1);
  assert.strictEqual(ok[0].index, 2);
  assert.strictEqual(ok[0].re.flags, 'dgim');
  assert.match(errors[0], /^BDD040 bddSuite\.bindings\.go\.recognizers\[0\]/);
  assert.match(errors[1], /^BDD041 bddSuite\.bindings\.go\.recognizers\[1\]/);
  assert.match(compileRecognizers([{ pattern: 'x' }]).errors[0], /^BDD040 recognizers\[0\]/);
});

test('a match without a name value is skipped', () => {
  const { ok } = compileRecognizers([{ pattern: 'a(?<name>b?)c' }]);
  assert.deepStrictEqual(scanRegistrations('ac abc', '/f', 'x', ok).map(s => s.action), ['b']);
});

const SKIP = new Set(['node_modules', 'target', '.git', 'artifacts', 'bin', 'obj']);
function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (SKIP.has(e.name) || e.name.startsWith('target-') ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]);
}

test('B1.4-1 each default recognizer finds exactly the catalog declarations on the real tree', (t) => {
  const root = process.env.OS_CONTEXT_ROOT;
  if (!root) {
    t.skip('OS_CONTEXT_ROOT is not set');
    return;
  }
  const catalogFile = path.join(root, 'test/e2e/schema/actions.catalog.yaml');
  const catalog = parseCatalog(fs.readFileSync(catalogFile, 'utf8'), catalogFile);
  const problems: string[] = [];
  const all = ['scripts', 'test'].flatMap(d => walk(path.join(root, d)));
  for (const [binding, settings] of Object.entries(DEFAULT_BINDINGS)) {
    const files = all.map((f: string) => path.relative(root, f).split(path.sep).join('/'))
      .filter(r => settings.sources.some(g => minimatch(r, g)) && !settings.exclude.some(g => minimatch(r, g)));
    const found = new Map<string, number>();
    for (const r of files) {
      for (const s of scan(binding, fs.readFileSync(path.join(root, r), 'utf8'))) found.set(s.action, (found.get(s.action) ?? 0) + 1);
    }
    const declared = [...catalog.actions.values()].filter(a => a.bindings.includes(binding)).map(a => a.name);
    for (const name of declared) if (!found.has(name)) problems.push(`${binding}: declared, not found: ${name}`);
    for (const [name, n] of found) {
      if (!declared.includes(name)) problems.push(`${binding}: found, not declared: ${name}`);
      else if (n !== 1) problems.push(`${binding}: ${n} sites for ${name}`);
    }
    t.diagnostic(`${binding}: ${files.length} files, ${declared.length} declared, ${found.size} found`);
  }
  assert.deepStrictEqual(problems, []);
});

test('sites on one line are ordered by column; a prefix is prepended', () => {
  const { ok } = compileRecognizers([{ pattern: 'b(?<name>\\w)' }, { pattern: 'a(?<name>\\w)', prefix: 'p.' }]);
  assert.deepStrictEqual(scanRegistrations('ax bx\n', '/f', 'x', ok).map(s => s.action), ['p.x', 'x']);
});

test('handlerIdentifier: the name a handler expression ends with; none for a lambda or nothing', () => {
  assert.strictEqual(handlerIdentifier('DemoGreet'), 'DemoGreet');
  assert.strictEqual(handlerIdentifier('actions.noop '), 'noop');
  assert.strictEqual(handlerIdentifier('Self::demo_greet'), 'demo_greet');
  assert.strictEqual(handlerIdentifier('request => Noop(request)'), undefined);
  assert.strictEqual(handlerIdentifier('bySuffix("lifecycle", false)'), undefined);
  assert.strictEqual(handlerIdentifier(undefined), undefined);
  assert.strictEqual(handlerIdentifier('   '), undefined);
});

test('findHandlerDeclaration: a C# method, a Go func and method, a Rust fn, a TypeScript function; never a call or a registration', () => {
  const at = (text: string, id: string) => {
    const d = findHandlerDeclaration(text, id);
    return d && text.slice(d.start, d.end);
  };
  assert.strictEqual(at('    private static object? DemoGreet(ActionRequest request) =>', 'DemoGreet'), 'DemoGreet');
  assert.strictEqual(at('    public static Task<int> Run<T>(T x) {', 'Run'), 'Run');
  assert.strictEqual(at('func demoGreet(request *Request) (any, error) {', 'demoGreet'), 'demoGreet');
  assert.strictEqual(at('func (s *server) demoGreet(r *Request) error {', 'demoGreet'), 'demoGreet');
  assert.strictEqual(at('pub(crate) fn demo_greet(_r: &Request) -> Outcome {', 'demo_greet'), 'demo_greet');
  assert.strictEqual(at('export async function demoGreet(request: Request) {', 'demoGreet'), 'demoGreet');
  assert.strictEqual(at('    "demo.greet": demoGreet,\n    x := demoGreet(r)', 'demoGreet'), undefined);
  assert.strictEqual(at('  action(\'demo.greet\', demoGreet),', 'demoGreet'), undefined);
  assert.strictEqual(at('    const demoGreet = (r: Request) => r;', 'demoGreet'), undefined);
  assert.strictEqual(at('func other(r *Request) { return demoGreet(r) }', 'demoGreet'), undefined);
});

test('scanRegistrations: each site carries where its handler is declared in the same file, when it is', () => {
  const go = scan('go', 'func Registry() map[string]Handler {\n\treturn map[string]Handler{\n\t\t"demo.greet": demoGreet,\n\t\t"demo.gone": elsewhere,\n\t}\n}\n\nfunc demoGreet(r *Request) (any, error) {\n\treturn nil, nil\n}\n');
  assert.deepStrictEqual(go.map(s => [s.action, s.handlerRange?.start.line ?? null, s.handlerRange?.start.character ?? null]),
    [['demo.greet', 7, 5], ['demo.gone', null, null]]);
  const cs = scan('csharp', '        {\n            ["demo.greet"] = DemoGreet,\n        };\n\n    private static object? DemoGreet(ActionRequest request) => null;\n');
  assert.deepStrictEqual(cs[0].handlerRange, { start: { line: 4, character: 27 }, end: { line: 4, character: 36 } });
  assert.strictEqual(scan('powershell', "Register-LabAction -Name 'demo.greet' -Handler {")[0].handlerRange, undefined, 'an inline script block has no declaration');
});
