// B1.4: compileRecognizers, scanRegistrations; B1.4-1 against the runtimes' example extensions.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { minimatch } from 'minimatch';
import { DEFAULT_BINDINGS } from '../../src/config/defaults';
import { compileRecognizers, findHandlerDeclaration, handlerIdentifier, scanRegistrations } from '../../src/core/registrations';

const scan = (binding: string, text: string) =>
  scanRegistrations(text, `/src.${binding}`, binding, compileRecognizers(DEFAULT_BINDINGS[binding].recognizers).ok);
const names = (binding: string, text: string) => scan(binding, text).map(s => [s.action, s.handler ?? null]);

test('powershell: Register-SuiteAction and its alias Register-LabAction, single and double quotes; commented and near-miss lines are not sites', () => {
  const text = [
    "Register-SuiteAction -Name 'cluster.resume' -Handler {",
    'Register-SuiteAction -Name "orders.ship" -Handler {',
    "Register-LabAction -Name 'legacy.alias' -Handler {",
    "# Register-SuiteAction -Name 'commented.out' -Handler {",
    "    Register-SuiteAction  -Name   'wait' -Handler {",
    "Get-SuiteAction -Name 'not.a.registration'",
    "Register-SuiteAction -Name \"$built\" -Handler {",
  ].join('\n');
  assert.deepStrictEqual(names('powershell', text),
    [['cluster.resume', null], ['orders.ship', null], ['legacy.alias', null], ['wait', null]]);
});

test('go: entries of []actions.Registration, with the handler when it is a name; near misses', () => {
  const text = [
    'var Registrations = []actions.Registration{',
    '\t{Name: "demo.greet", Handler: demoGreet},',
    '\t{Name: "demo.count", Handler: handlers.Count},',
    '\t{Name: "demo.inline", Handler: func(r *actions.Request) (any, error) { return nil, nil }},',
    '\t// {Name: "commented.out", Handler: x},',
    '\tName: "not.in.braces"',
    '\t{Name: "no.handler"}',
    '}',
  ].join('\n');
  assert.deepStrictEqual(names('go', text),
    [['demo.greet', 'demoGreet'], ['demo.count', 'handlers.Count'], ['demo.inline', null]]);
});

test('rust: Action::new, with the handler when it is a path; a closure has none', () => {
  const text = [
    '    vec![',
    '        Action::new("demo.greet", demo_greet),',
    '        Action::new("demo.count", handlers::count),',
    '        Action::new("demo.inline", |_request| Ok(Value::Null)),',
    '        // Action::new("commented.out", x),',
    '        Other::new("not.this", x),',
    '    ]',
  ].join('\n');
  assert.deepStrictEqual(names('rust', text),
    [['demo.greet', 'demo_greet'], ['demo.count', 'handlers::count'], ['demo.inline', null]]);
});

test('csharp: new ActionRegistration, with the handler when it is a name; a lambda has none', () => {
  const text = [
    '    public static IReadOnlyList<ActionRegistration> All { get; } =',
    '    [',
    '        new ActionRegistration("demo.greet", DemoGreet),',
    '        new ActionRegistration("demo.count", Handlers.Count),',
    '        new ActionRegistration("demo.inline", request => null),',
    '        // new ActionRegistration("commented.out", X),',
    '        new OtherRegistration("not.this", X),',
    '    ];',
  ].join('\n');
  assert.deepStrictEqual(names('csharp', text),
    [['demo.greet', 'DemoGreet'], ['demo.count', 'Handlers.Count'], ['demo.inline', null]]);
});

test('typescript: action() registrations, with the handler when it is a name', () => {
  const text = [
    'export const registrations: readonly Registration[] = [',
    "  action('core.noop', noop),",
    "  action('wait', wait),",
    "  action('demo.inline', async request => request.step),",
    "  // action('commented.out', x),",
    "  transaction('not.this', x),",
    '];',
  ].join('\n');
  assert.deepStrictEqual(names('typescript', text), [['core.noop', 'noop'], ['wait', 'wait'], ['demo.inline', null]]);
});

test('B1.4-2 the range of a site is the name inside its quotes', () => {
  const text = 'x\n\t{Name: "core.noop", Handler: noop},\n';
  const [site] = scan('go', text);
  assert.deepStrictEqual(site.range, { start: { line: 1, character: 9 }, end: { line: 1, character: 18 } });
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

// The runtimes' own example extensions register example.echo in each language's
// extension API (DEC-S11), so each default recognizer must find it there once.
const RUNTIMES = path.resolve(__dirname, '../../../runtimes');
const EXAMPLES: Record<string, string> = {
  powershell: 'powershell/example/actions/Echo.ps1',
  go: 'go/example/extension.go',
  rust: 'rust/example/src/extension.rs',
  csharp: 'csharp/Bdd.Suite.Example/EchoExtension.cs',
  typescript: 'typescript/example/src/extension.ts',
};

test('B1.4-1 each default recognizer finds the runtimes\' example registration exactly once', (t) => {
  assert.deepStrictEqual(Object.keys(EXAMPLES).sort(), Object.keys(DEFAULT_BINDINGS).sort());
  for (const [binding, file] of Object.entries(EXAMPLES)) {
    const sites = scan(binding, fs.readFileSync(path.join(RUNTIMES, file), 'utf8'));
    assert.deepStrictEqual(sites.map(x => x.action), ['example.echo'], file);
    t.diagnostic(`${binding}: ${file}: ${sites[0].handler ?? '(inline handler)'}`);
  }
});

test('default sources: each binding\'s layout, without generated or test files', () => {
  const owns = (binding: string, file: string) => DEFAULT_BINDINGS[binding].sources.some(g => minimatch(file, g, { dot: true }))
    && !DEFAULT_BINDINGS[binding].exclude.some(g => minimatch(file, g, { dot: true }));
  assert.ok(owns('powershell', 'scripts/e2e/actions/DemoGreet.ps1'));
  assert.ok(!owns('powershell', 'scripts/e2e/actions/DemoGreet.Tests.ps1'));
  assert.ok(owns('go', 'test/e2e/bindings/go/actions/actions.go'));
  assert.ok(!owns('go', 'test/e2e/bindings/go/actions/actions_test.go'));
  assert.ok(owns('rust', 'test/e2e/bindings/rust/src/actions.rs'));
  assert.ok(owns('csharp', 'test/e2e/bindings/dotnet/Suite.Cli/Actions.cs'));
  for (const generated of ['artifacts/bin/Suite.Cli/x.cs', 'Suite.Cli/obj/Debug/x.cs', 'Suite.Cli/bin/x.cs']) {
    assert.ok(!owns('csharp', `test/e2e/bindings/dotnet/${generated}`), generated);
  }
  assert.ok(owns('typescript', 'test/e2e/bindings/typescript/src/actions.ts'));
  assert.ok(!owns('typescript', 'test/e2e/bindings/typescript/src/actions.test.ts'));
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
  const go = scan('go', 'var Registrations = []actions.Registration{\n\t{Name: "demo.greet", Handler: demoGreet},\n\t{Name: "demo.gone", Handler: elsewhere},\n}\n\nfunc demoGreet(r *actions.Request) (any, error) {\n\treturn nil, nil\n}\n');
  assert.deepStrictEqual(go.map(s => [s.action, s.handlerRange?.start.line ?? null, s.handlerRange?.start.character ?? null]),
    [['demo.greet', 5, 5], ['demo.gone', null, null]]);
  const cs = scan('csharp', '    [\n        new ActionRegistration("demo.greet", DemoGreet),\n    ];\n\n    private static object? DemoGreet(ActionRequest request) => null;\n');
  assert.deepStrictEqual(cs[0].handlerRange, { start: { line: 4, character: 27 }, end: { line: 4, character: 36 } });
  const rust = scan('rust', '        Action::new("demo.greet", demo_greet),\n\nfn demo_greet(_request: &Request) -> Outcome {\n');
  assert.deepStrictEqual(rust[0].handlerRange, { start: { line: 2, character: 3 }, end: { line: 2, character: 13 } });
  assert.strictEqual(scan('powershell', "Register-SuiteAction -Name 'demo.greet' -Handler {")[0].handlerRange, undefined, 'an inline script block has no declaration');
});
