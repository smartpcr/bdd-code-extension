// The lint oracle (E-B1, DEC-S11). The conformance corpus is proven by each
// runtime's own CI job; what the editor must show for the sample workspace's
// suites is what the runtimes themselves report. For every suite file under
// samples/workspace/test/e2e/suites and every target binding, each of the five
// `suiterun` programs runs `lint --path <file> --json --binding-check
// --binding <target>` from the sample root (the command the editor runs);
// their answers must agree, and that answer is the expectation.
//
// runTest computes it once per run, after the sample is built, and writes it
// to .vscode-test/sample-oracle.json; tests in the editor host and the node
// tests read it. It is recomputed when the suites, the catalogs, the
// PowerShell runtime or a program changed.
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BINDINGS, BindingName, buildSample, repo, samplePrograms, sampleRoot } from './sample';

export interface ExpectedDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  line: number;
  column: number;
  message?: string;
  suggestion?: string;
}

export interface ValidateEntry {
  /** "<file relative to test/e2e/suites> -> <target>", for messages. */
  suite: string;
  /** The suite path relative to the sample root, with forward slashes. */
  rel: string;
  /** The binding the lint checks portability against (`--binding-check --binding`). */
  target: string;
  exitCode: number;
  diagnostics: ExpectedDiagnostic[];
}

interface OracleFile {
  fingerprint: string;
  root: string;
  computed: string;
  entries: ValidateEntry[];
}

export const oracleFile = (): string => path.join(repo, '.vscode-test', 'sample-oracle.json');

/** Every suite file (a top-level `suite:` key) under test/e2e/suites, libraries in `_lib` excluded, relative and sorted. */
export function sampleSuites(root = sampleRoot()): string[] {
  const base = path.join(root, 'test', 'e2e', 'suites');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name.startsWith('_') ? [] : walk(p);
    return e.name.endsWith('.yml') && /^suite:/m.test(fs.readFileSync(p, 'utf8')) ? [p] : [];
  });
  return walk(base).map(p => path.relative(root, p).replace(/\\/g, '/')).sort();
}

/** What the oracle depends on: the suites, the schema, the core catalog, the PowerShell runtime and the programs. */
function fingerprint(root: string): string {
  const h = createHash('sha256');
  const files = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []).sort();
  for (const f of [
    ...files(path.join(root, 'test', 'e2e', 'suites')), ...files(path.join(root, 'test', 'e2e', 'schema')),
    ...files(path.join(root, 'scripts', 'e2e')), path.join(repo, 'spec', 'core.catalog.yaml'),
    ...files(path.join(repo, 'runtimes', 'powershell', 'BddSuite')),
  ]) h.update(f).update(fs.readFileSync(f));
  // The programs by content (a rebuild that changes nothing keeps the oracle): C#'s code is in
  // suiterun.dll beside its apphost, TypeScript's in its dist/ and the runtime's dist/.
  const programs = samplePrograms(root);
  for (const f of [
    programs.go[0], programs.rust[0], programs.csharp[0], programs.csharp[0].replace(/(\.exe)?$/, '.dll'),
    ...files(path.dirname(programs.typescript[1])), ...files(path.join(repo, 'runtimes', 'typescript', 'dist')),
  ].filter(x => fs.existsSync(x))) h.update(f).update(fs.readFileSync(f));
  return h.digest('hex');
}

function run(argv: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('error', e => resolve({ code: -1, stdout, stderr: String(e) }));
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

/** Run every binding's lint of every suite for every target; throw when two bindings disagree. */
export async function computeOracle(root = sampleRoot(), concurrency = 8): Promise<ValidateEntry[]> {
  const programs = samplePrograms(root);
  const jobs: { rel: string; target: BindingName; binding: BindingName }[] = [];
  for (const rel of sampleSuites(root)) for (const target of BINDINGS) for (const binding of BINDINGS) jobs.push({ rel, target, binding });
  const answers = new Map<string, Map<BindingName, string>>();
  const failures: string[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      const r = await run([...programs[j.binding], 'lint', '--path', j.rel, '--json', '--binding-check', '--binding', j.target], root);
      let diagnostics: ExpectedDiagnostic[];
      try {
        diagnostics = (JSON.parse(r.stdout) as ExpectedDiagnostic[]).map(d => ({
          code: d.code, severity: d.severity, line: d.line, column: d.column, message: d.message,
          ...(d.suggestion !== undefined ? { suggestion: d.suggestion } : {}),
        }));
      } catch {
        failures.push(`${j.binding} ${j.rel} -> ${j.target}: not JSON (exit ${r.code}): ${r.stdout.slice(0, 200)} ${r.stderr.slice(-400)}`);
        continue;
      }
      const key = `${j.rel}|${j.target}`;
      if (!answers.has(key)) answers.set(key, new Map());
      answers.get(key)!.set(j.binding, JSON.stringify({ exitCode: r.code, diagnostics }));
    }
  }));
  const entries: ValidateEntry[] = [];
  for (const [key, byBinding] of [...answers].sort(([a], [b]) => a.localeCompare(b))) {
    const [rel, target] = key.split('|');
    const distinct = new Set(byBinding.values());
    if (distinct.size !== 1 || byBinding.size !== BINDINGS.length) {
      failures.push(`${rel} -> ${target}: the bindings disagree:\n${[...byBinding].map(([b, a]) => `    ${b}: ${a}`).join('\n')}`);
      continue;
    }
    const answer = JSON.parse([...distinct][0]) as { exitCode: number; diagnostics: ExpectedDiagnostic[] };
    entries.push({ suite: `${rel.replace(/^test\/e2e\/suites\//, '')} -> ${target}`, rel, target, ...answer });
  }
  if (failures.length) throw new Error(`The lint oracle has no single answer:\n  ${failures.join('\n  ')}`);
  return entries;
}

/** The oracle for the sample, from .vscode-test/sample-oracle.json when it is current, else computed and written. */
export async function ensureOracle(root = sampleRoot()): Promise<ValidateEntry[]> {
  const fp = fingerprint(root);
  const file = oracleFile();
  if (fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as OracleFile;
    if (cached.fingerprint === fp && cached.root === root) return cached.entries;
  }
  const started = Date.now();
  const entries = await computeOracle(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fingerprint: fp, root, computed: new Date().toISOString(), entries } satisfies OracleFile, null, 2));
  console.log(`Lint oracle: ${entries.length} entries (suite x target), five bindings agree on each; ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return entries;
}

/**
 * Build the sample (buildSample) and make the oracle current, once at a time
 * across processes (node --test runs test files in parallel, and two builds in
 * one folder collide): a lock directory beside the oracle file, taken over when
 * it is older than 15 minutes.
 */
export async function prepareSample(root = sampleRoot()): Promise<ValidateEntry[]> {
  const lock = `${oracleFile()}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      const age = fs.existsSync(lock) ? Date.now() - fs.statSync(lock).mtimeMs : 0;
      if (age > 15 * 60_000) fs.rmSync(lock, { recursive: true, force: true });
      else await new Promise(r => setTimeout(r, 500));
    }
  }
  try {
    buildSample(root);
    return await ensureOracle(root);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * The oracle's entries, read from the file runTest wrote. They describe the
 * main checkout's sample; a worktree session's sample starts as a copy of it,
 * so the same relative paths apply there.
 */
export function validateEntries(_root?: string): { entries: ValidateEntry[]; excluded: string[] } {
  const file = oracleFile();
  if (!fs.existsSync(file)) throw new Error(`No lint oracle at ${file}; runTest (or ensureOracle) computes it.`);
  return { entries: (JSON.parse(fs.readFileSync(file, 'utf8')) as OracleFile).entries, excluded: [] };
}

export const sig = (d: ExpectedDiagnostic): string => `${d.code} ${d.severity} ${d.line}:${d.column}`;
