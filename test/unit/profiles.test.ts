// B2.1: the command line per verb and binding.
import * as assert from 'assert';
import * as path from 'path';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../../src/config/defaults';
import { ResolvedBinding, WorkspaceLayout } from '../../src/config/layout';
import { actionsCommand, buildCommand, lintCommand, listCommand, OFFLINE_API_URL, programPath, psQuote, runCommand, runnerPath } from '../../src/tools/profiles';

const root = path.resolve('/repo');
const catalog = path.join(root, 'test', 'e2e', 'schema', 'actions.catalog.yaml');
const exists = (p: string) => [catalog, path.join(root, 'test', 'e2e', 'schema')].map(x => x.toLowerCase()).includes(p.toLowerCase());
const layout = WorkspaceLayout.create(root, DEFAULT_SETTINGS, path.resolve('/st ore'), exists)!;
const b = (name: string): ResolvedBinding => layout.bindings.find(x => x.name === name)!;
const R = layout.root;

test('psQuote doubles single quotes', () => {
  assert.strictEqual(psQuote("it's"), "'it''s'");
});

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

test('powershell lint: one -Command script with every value quoted', () => {
  const c = lintCommand(b('powershell'), R, "suites/o'brien.yml", 'rust');
  assert.deepStrictEqual(c.argv.slice(0, 4), ['pwsh', '-NoProfile', '-NonInteractive', '-Command']);
  const script = c.argv[4];
  assert.match(script, /Import-Module -Force \(Join-Path '.+' 'scripts\/e2e\/SuiteLint\.psm1'\)/);
  assert.ok(script.includes("-Path @('suites/o''brien.yml') -Binding 'rust' -BindingCheck"));
  assert.match(script, /ConvertTo-Json -InputObject \$d -Depth 5 -Compress$/);
});

test('a target that is not a binding name is refused before anything is built', () => {
  assert.throws(() => lintCommand(b('go'), R, 'x.yml', "go'; rm"), /Not a binding name/);
});

test('actions: suiterun and powershell', () => {
  assert.deepStrictEqual(actionsCommand(b('csharp'), R).argv.slice(1), ['actions', '--json']);
  const ps = actionsCommand(b('powershell'), R).argv[4];
  assert.match(ps, /scripts\/e2e\/actions\/ActionRegistry\.ps1/);
  assert.match(ps, /Get-LabActionNames/);
});

test('list: with and without tags', () => {
  assert.deepStrictEqual(listCommand(b('go'), R, 's.yml', []).argv.slice(1), ['list', '--path', 's.yml']);
  assert.deepStrictEqual(listCommand(b('go'), R, 's.yml', ['a', 'b']).argv.slice(1), ['list', '--path', 's.yml', '--tags', 'a,b']);
  assert.match(listCommand(b('powershell'), R, 's.yml', []).argv[4], /-DryRun$/);
  assert.match(listCommand(b('powershell'), R, 's.yml', ['x']).argv[4], /-Tags 'x'$/);
  assert.match(listCommand(b('powershell'), R, 's.yml', [], 'one case').argv[4], /-DryRun -TestName 'one case'$/);
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

test('B6.2-B6.4 run under PowerShell: -File with named parameters; offline gets the corpus\'s unreachable API', () => {
  const o = { traceFile: 't.json', resultsFile: 'r.xml' };
  const off = runCommand(b('powershell'), R, 's.yml', o).argv;
  assert.deepStrictEqual(off.slice(0, 5), ['pwsh', '-NoProfile', '-NonInteractive', '-File', path.join(R, 'scripts', 'e2e', 'Invoke-LabTestSuite.ps1')]);
  assert.deepStrictEqual(off.slice(5), ['-Path', 's.yml', '-TraceFile', 't.json', '-ResultsFile', 'r.xml', '-ApiUrl', OFFLINE_API_URL]);
  assert.deepStrictEqual(runCommand(b('powershell'), R, 's.yml', { ...o, dryRun: true, tags: ['p'], testName: 'one case' }).argv.slice(11),
    ['-Tags', 'p', '-TestName', 'one case', '-DryRun']);
  assert.deepStrictEqual(runCommand(b('powershell'), R, 's.yml', { ...o, lab: { apiUrl: 'https://api', labId: 'lab1', connectionFile: 'C:/c.json' } }).argv.slice(11),
    ['-ApiUrl', 'https://api', '-LabId', 'lab1', '-ConnectionFile', 'C:/c.json']);
  assert.deepStrictEqual(runCommand(b('powershell'), R, 's.yml', { ...o, lab: {} }).argv.length, 11, 'a lab run passes only the values it has');
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

test('programPath: the program file a binding runs', () => {
  assert.strictEqual(programPath(b('rust'), R), path.resolve(R, 'test/e2e/bindings/rust/target/debug/suiterun.exe'));
  assert.strictEqual(programPath(b('typescript'), R), path.resolve(R, 'test/e2e/bindings/typescript/dist/cli.js'));
  assert.strictEqual(programPath(b('powershell'), R), undefined);
  const empty = { ...b('go'), tool: [] };
  assert.strictEqual(programPath(empty, R), undefined);
  assert.deepStrictEqual(lintCommand(empty, R, 'x', 'go').argv, ['lint', '--path', 'x', '--json', '--binding-check', '--binding', 'go']);
  assert.strictEqual(programPath({ ...b('go'), tool: ['suiterun'] }, R), undefined);
});

test('runnerPath: the runner script for PowerShell, the program otherwise', () => {
  assert.strictEqual(runnerPath(b('powershell'), R), path.join(R, 'scripts', 'e2e', 'Invoke-LabTestSuite.ps1'));
  assert.strictEqual(runnerPath(b('rust'), R), programPath(b('rust'), R));
});
