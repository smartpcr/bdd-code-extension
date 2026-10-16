#!/usr/bin/env node
// Runs the sample workspace's five suiterun programs side by side and fails
// when they disagree (D8, S5.4):
//
//   actions  each binding's `actions --json` is the core plus exactly the
//            actions the catalog lists for that binding (report.export is the
//            one declared action no binding implements, by design)
//   lint     `lint --json` (plain, and with --binding-check for every binding
//            as target) gives the same document and exit code in every binding,
//            for every suite under test/e2e/suites
//   list     `list` gives the same lines in every binding
//   run      every binding that registers all of a suite's actions runs it to
//            the same trace with exit 0; every other binding fails the same
//            cases with exit 1
//
// Usage, from anywhere:
//   node samples/workspace/tools/compare-bindings.mjs [--build] [--verbose]
//
// --build builds every binding first (go build, cargo build, dotnet build,
// npm ci && npm run build); without it the programs must already be built.
// Exit code: 0 when everything agrees, 1 when anything differs.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(workspace, '../..');
const exe = process.platform === 'win32' ? '.exe' : '';
const verbose = process.argv.includes('--verbose');
const BINDINGS = ['powershell', 'csharp', 'go', 'rust', 'typescript'];
/** Declared in the catalog and registered by no binding, on purpose. */
const DECLARED_NOT_REGISTERED = new Set(['report.export']);

const programs = {
  powershell: ['pwsh', '-NoProfile', '-File', path.join(workspace, 'scripts/e2e/suiterun.ps1')],
  csharp: [path.join(workspace, `test/e2e/bindings/dotnet/artifacts/bin/Suite.Cli/Debug/net10.0/suiterun${exe}`)],
  go: [path.join(workspace, `test/e2e/bindings/go/suiterun${exe}`)],
  rust: [path.join(workspace, `test/e2e/bindings/rust/target/debug/suiterun${exe}`)],
  typescript: [process.execPath, path.join(workspace, 'test/e2e/bindings/typescript/dist/cli.js')],
};

let failures = 0;
const fail = message => {
  failures++;
  console.log(`  FAIL ${message}`);
};
const pass = message => console.log(`  ok   ${message}`);

function exec(argv, cwd, shell = false) {
  const r = spawnSync(shell ? argv.join(' ') : argv[0], shell ? [] : argv.slice(1),
    { cwd, encoding: 'utf8', shell, maxBuffer: 64 * 1024 * 1024, timeout: 900_000 });
  return { code: r.status, out: r.stdout ?? '', err: `${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

function build() {
  const steps = [
    ['go', ['go', 'build', '-o', `suiterun${exe}`, './cmd/suiterun'], 'test/e2e/bindings/go'],
    ['rust', ['cargo', 'build'], 'test/e2e/bindings/rust'],
    ['csharp', ['dotnet', 'build', 'Suite.sln'], 'test/e2e/bindings/dotnet'],
    ['typescript', ['npm ci && npm run build'], 'test/e2e/bindings/typescript', true],
  ];
  for (const [name, argv, dir, shell] of steps) {
    const r = exec(argv, path.join(workspace, dir), !!shell);
    if (r.code !== 0) {
      console.log(r.out, r.err);
      throw new Error(`${name} did not build`);
    }
    console.log(`built ${name}`);
  }
}

const suiterun = (binding, args) => exec([...programs[binding], ...args], workspace);

/** Each action of a catalog file and the bindings it lists, read line by line. */
function catalogActions(file) {
  const out = new Map();
  let current;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const name = /^  - name: (\S+)/.exec(line);
    if (name) current = name[1];
    const bindings = /^    bindings: \[(.*)\]/.exec(line);
    if (current && bindings) out.set(current, bindings[1].split(',').map(b => b.trim()).filter(Boolean));
  }
  return out;
}

function declaredFor(binding) {
  const all = new Map([...catalogActions(path.join(repository, 'spec/core.catalog.yaml')),
    ...catalogActions(path.join(workspace, 'test/e2e/schema/actions.catalog.yaml'))]);
  return [...all].filter(([name, bindings]) => bindings.includes(binding) && !DECLARED_NOT_REGISTERED.has(name))
    .map(([name]) => name).sort();
}

function suiteFiles(dir = path.join(workspace, 'test/e2e/suites')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.isDirectory()) return e.name.startsWith('_') ? [] : suiteFiles(path.join(dir, e.name));
    return e.name.endsWith('.yml') ? [path.join(dir, e.name)] : [];
  }).sort();
}

/** Every action a suite file names, its imports' included. */
function actionsOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const names = new Set([...text.matchAll(/action: ([A-Za-z0-9.]+)/g)].map(m => m[1]));
  for (const m of text.matchAll(/^  - (_lib\/\S+\.yml)/gm)) for (const n of actionsOf(path.join(path.dirname(file), m[1]))) names.add(n);
  return names;
}

const rel = file => path.relative(workspace, file).replace(/\\/g, '/');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function parseJson(binding, r, what) {
  try {
    return JSON.parse(r.out);
  } catch {
    fail(`${binding} ${what}: not JSON (exit ${r.code}): ${r.out.slice(0, 200)} ${r.err.slice(0, 400)}`);
    return undefined;
  }
}

/** Every binding's answer to one command, compared with PowerShell's. */
function agree(what, args, read) {
  const answers = BINDINGS.map(b => {
    const r = suiterun(b, args);
    return { binding: b, code: r.code, value: read(b, r) };
  });
  const [first] = answers;
  const differ = answers.filter(a => a.code !== first.code || !same(a.value, first.value));
  if (differ.length) {
    fail(`${what}: ${differ.map(d => d.binding).join(', ')} differ from powershell`);
    for (const a of answers) console.log(`       ${a.binding} exit ${a.code}: ${JSON.stringify(a.value)}`);
  } else {
    pass(`${what}: exit ${first.code}${verbose ? ` ${JSON.stringify(first.value)}` : ''}`);
  }
  return answers;
}

if (process.argv.includes('--build')) build();

console.log('actions --json against the catalog');
const registered = {};
for (const b of BINDINGS) {
  const r = suiterun(b, ['actions', '--json']);
  const names = parseJson(b, r, 'actions --json');
  registered[b] = new Set(names ?? []);
  const want = declaredFor(b);
  if (r.code === 0 && same(names, want)) pass(`${b}: ${names.length} actions`);
  else fail(`${b}: got ${JSON.stringify(names)}, the catalog declares ${JSON.stringify(want)}`);
}

const files = suiteFiles();
console.log(`lint --json, ${files.length} suite files`);
for (const file of files) {
  const r = rel(file);
  agree(`lint ${r}`, ['lint', '--path', r, '--json'], (b, x) => parseJson(b, x, `lint ${r}`));
  for (const target of BINDINGS) {
    agree(`lint ${r} --binding-check --binding ${target}`, ['lint', '--path', r, '--json', '--binding-check', '--binding', target],
      (b, x) => parseJson(b, x, `lint ${r} for ${target}`));
  }
}
agree('lint test/e2e/suites/*.yml', ['lint', '--path', 'test/e2e/suites/*.yml', '--json'], (b, x) => parseJson(b, x, 'lint *.yml'));

console.log('list');
for (const file of files) agree(`list ${rel(file)}`, ['list', '--path', rel(file)], (_, x) => x.out.trim().split(/\r?\n/));

console.log('run');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-compare-'));
for (const file of files) {
  const r = rel(file);
  const clean = suiterun('typescript', ['lint', '--path', r]);
  if (clean.code !== 0) continue;
  const needs = actionsOf(file);
  const runs = BINDINGS.map(b => {
    const traceFile = path.join(scratch, `${b}-${path.basename(file)}.trace.json`);
    const x = suiterun(b, ['run', '--path', r, '--trace-file', traceFile]);
    const trace = fs.existsSync(traceFile) ? JSON.parse(fs.readFileSync(traceFile, 'utf8')) : undefined;
    const cases = (trace ?? []).filter(t => t.phase === 'case').map(t => `${t.case}=${t.status}`);
    return { binding: b, code: x.code, trace, cases, able: [...needs].every(n => registered[b].has(n)), out: x.out + x.err };
  });
  const able = runs.filter(x => x.able);
  const unable = runs.filter(x => !x.able);
  for (const group of [able, unable]) {
    if (!group.length) continue;
    const [first] = group;
    const wantCode = group === able ? 0 : 1;
    const bad = group.filter(x => x.code !== wantCode || !same(x.trace, first.trace));
    const label = `run ${r} [${group.map(x => x.binding).join(', ')}]`;
    if (bad.length || !first.trace) {
      fail(`${label}: want exit ${wantCode} and one trace; ${bad.map(x => `${x.binding} exit ${x.code}`).join(', ')}`);
      for (const x of group) console.log(`       ${x.binding} exit ${x.code}: ${x.cases.join(' ')}\n${verbose ? x.out : ''}`);
    } else {
      pass(`${label}: exit ${first.code}, ${first.trace.length} trace entries, ${first.cases.join(' ')}`);
    }
  }
  if (able.length && unable.length) {
    const a = able[0].cases.map(c => c.split('=')[0]);
    const u = unable[0].cases.map(c => c.split('=')[0]);
    if (!same(a, u)) fail(`run ${r}: the bindings that cannot run it report other cases (${u}) than those that can (${a})`);
  }
}
fs.rmSync(scratch, { recursive: true, force: true });

console.log(failures ? `${failures} disagreement(s).` : 'All five bindings agree.');
process.exitCode = failures ? 1 : 0;
