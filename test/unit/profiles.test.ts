// B2.1: the command line per verb and binding. Every binding, PowerShell
// included, is a program with the same verbs and flags (DEC-S11).
import * as assert from 'assert';
import * as path from 'path';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../../src/config/defaults';
import { ResolvedBinding, WorkspaceLayout } from '../../src/config/layout';
import { actionsCommand, buildCommand, lintCommand, listCommand, programPath, runCommand } from '../../src/tools/profiles';

const root = path.resolve('/repo');
const catalog = path.join(root, 'test', 'e2e', 'schema', 'actions.catalog.yaml');
const exists = (p: string) => [catalog, path.join(root, 'test', 'e2e', 'schema')].map(x => x.toLowerCase()).includes(p.toLowerCase());
const layout = WorkspaceLayout.create(root, DEFAULT_SETTINGS, path.resolve('/st ore'), exists)!;
const b = (name: string): ResolvedBinding => layout.bindings.find(x => x.name === name)!;
const R = layout.root;
const PWSH = ['pwsh', '-NoProfile', '-NonInteractive', '-File', 'scripts/e2e/suiterun.ps1'];

test('suiterun lint: absolute program, the shared flags, the target', () => {
  const c = lintCommand(b('rust'), R, 'test/e2e/suites/a b.yml', 'go');
  assert.deepStrictEqual(c.argv, [path.resolve(R, 'test/e2e/bindings/rust/target/debug/suiterun.exe'),
    'lint', '--path', 'test/e2e/suites/a b.yml', '--json', '--binding-check', '--binding', 'go']);
  assert.strictEqual(c.cwd, R);
  assert.strictEqual(c.shell, undefined);
  assert.strictEqual(c.timeoutMs, 20_000);
});

test('a bare program name is left for PATH; an absolute one is kept', () => {
  const node = lintCommand(b('typescript'), R, 'x.yml', 'powershell');
  assert.deepStrictEqual(node.argv.slice(0, 2), ['node', 'test/e2e/bindings/typescript/dist/cli.js']);
  const go = lintCommand(b('go'), R, 'x.yml', 'powershell');
  assert.strictEqual(go.argv[0], path.resolve('/st ore') + '/go/suiterun.exe');
});

test('S5a.2 PowerShell lint: the workspace suiterun.ps1 with the same verb and flags as every program', () => {
  const c = lintCommand(b('powershell'), R, "suites/o'brien.yml", 'rust');
  assert.deepStrictEqual(c.argv, [...PWSH, 'lint', '--path', "suites/o'brien.yml", '--json', '--binding-check', '--binding', 'rust']);
  assert.strictEqual(c.cwd, R, 'the relative script resolves against the repository root');
});

test('a target that is not a binding name is refused before anything is built', () => {
  assert.throws(() => lintCommand(b('go'), R, 'x.yml', "go'; rm"), /Not a binding name/);
});

test('actions: one verb for every binding', () => {
  assert.deepStrictEqual(actionsCommand(b('csharp'), R).argv.slice(1), ['actions', '--json']);
  assert.deepStrictEqual(actionsCommand(b('powershell'), R).argv, [...PWSH, 'actions', '--json']);
});

test('list: with and without tags; --test-name only for a binding that selects one case', () => {
  assert.deepStrictEqual(listCommand(b('go'), R, 's.yml', []).argv.slice(1), ['list', '--path', 's.yml']);
  assert.deepStrictEqual(listCommand(b('go'), R, 's.yml', ['a', 'b']).argv.slice(1), ['list', '--path', 's.yml', '--tags', 'a,b']);
  assert.deepStrictEqual(listCommand(b('go'), R, 's.yml', [], 'one case').argv.slice(1), ['list', '--path', 's.yml'], 'go runs whole files');
  assert.deepStrictEqual(listCommand(b('powershell'), R, 's.yml', ['x']).argv, [...PWSH, 'list', '--path', 's.yml', '--tags', 'x']);
  assert.deepStrictEqual(listCommand(b('powershell'), R, 's.yml', [], 'one case').argv.slice(PWSH.length),
    ['list', '--path', 's.yml', '--test-name', 'one case']);
});

test('B6.2-B6.4 run: suiterun flags, dry run, tags, each lab value; no timeout, output streamed', () => {
  const o = { traceFile: 't.json', resultsFile: 'r.xml' };
  const go = runCommand(b('go'), R, 's.yml', o);
  assert.deepStrictEqual(go.argv.slice(1), ['run', '--path', 's.yml', '--trace-file', 't.json', '--results', 'r.xml', '--format', 'nunit3']);
  assert.deepStrictEqual([go.timeoutMs, go.streamOnly, go.cwd], [0, true, R]);
  assert.deepStrictEqual(runCommand(b('rust'), R, 's.yml', { ...o, dryRun: true, tags: ['a', 'b'], testName: 'ignored' }).argv.slice(10),
    ['--tags', 'a,b', '--dry-run']);
  assert.deepStrictEqual(runCommand(b('csharp'), R, 's.yml', { ...o, lab: { apiUrl: 'https://api', labId: 'lab1', connectionFile: 'C:/c.json' } }).argv.slice(10),
    ['--api-url', 'https://api', '--lab-id', 'lab1', '--connection-file', 'C:/c.json']);
  assert.deepStrictEqual(runCommand(b('go'), R, 's.yml', { ...o, lab: { labId: 'lab1' } }).argv.slice(10), ['--lab-id', 'lab1']);
  assert.deepStrictEqual(runCommand(b('go'), R, 's.yml', { ...o, tags: [] }).argv.length, 10, 'no --tags for an empty list');
});

test('S5a.2 run under PowerShell: the program flags plus --test-name; an offline run passes no lab flags', () => {
  const o = { traceFile: 't.json', resultsFile: 'r.xml' };
  const off = runCommand(b('powershell'), R, 's.yml', o).argv;
  assert.deepStrictEqual(off, [...PWSH, 'run', '--path', 's.yml', '--trace-file', 't.json', '--results', 'r.xml', '--format', 'nunit3']);
  const n = PWSH.length + 9;
  assert.deepStrictEqual(runCommand(b('powershell'), R, 's.yml', { ...o, dryRun: true, tags: ['p'], testName: 'one case' }).argv.slice(n),
    ['--tags', 'p', '--test-name', 'one case', '--dry-run']);
  assert.deepStrictEqual(runCommand(b('powershell'), R, 's.yml', { ...o, lab: { apiUrl: 'https://api', labId: 'lab1', connectionFile: 'C:/c.json' } }).argv.slice(n),
    ['--api-url', 'https://api', '--lab-id', 'lab1', '--connection-file', 'C:/c.json']);
  assert.deepStrictEqual(runCommand(b('powershell'), R, 's.yml', { ...o, lab: {} }).argv.length, n, 'a lab run passes only the values it has');
});

test('build: a shell command in the binding folder; storage quoted when it has spaces; none for powershell', () => {
  const go = buildCommand(b('go'), R)!;
  assert.deepStrictEqual(go.argv, [`go build -o "${path.resolve('/st ore')}"/go/suiterun.exe ./cmd/suiterun`]);
  assert.strictEqual(go.cwd, path.resolve(R, 'test/e2e/bindings/go'));
  assert.strictEqual(go.shell, true);
  assert.strictEqual(buildCommand(b('powershell'), R), undefined);
  const plain = WorkspaceLayout.create(root, DEFAULT_SETTINGS, path.resolve('/store'), exists)!;
  assert.ok(buildCommand(plain.bindings.find(x => x.name === 'go')!, R)!.argv[0].includes(`-o ${path.resolve('/store')}/go`));
});

test('programPath: the program file a binding runs, or the script its interpreter runs', () => {
  assert.strictEqual(programPath(b('rust'), R), path.resolve(R, 'test/e2e/bindings/rust/target/debug/suiterun.exe'));
  assert.strictEqual(programPath(b('typescript'), R), path.resolve(R, 'test/e2e/bindings/typescript/dist/cli.js'));
  assert.strictEqual(programPath(b('powershell'), R), path.resolve(R, 'scripts/e2e/suiterun.ps1'));
  const empty = { ...b('go'), tool: [] };
  assert.strictEqual(programPath(empty, R), undefined);
  assert.deepStrictEqual(lintCommand(empty, R, 'x', 'go').argv, ['lint', '--path', 'x', '--json', '--binding-check', '--binding', 'go']);
  assert.strictEqual(programPath({ ...b('go'), tool: ['suiterun'] }, R), undefined);
});
