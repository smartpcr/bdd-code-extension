// A small stand-in for the PowerShell suiterun's actions, list and run verbs
// (scripts/e2e/suiterun.ps1 calls it), so the demo's suites run from Test
// Explorer with no lab and no binding built. It touches nothing: a step passes
// when its action is registered in scripts/e2e/actions/*.ps1, and fails, with
// the rest of its case skipped, when it is not. It writes what the extension
// reads from a real run: the trace (a JSON array of entries) and an NUnit 3
// report.
// Usage (the program command line, as suiterun.ps1 passes it):
//   node tools/fake-run.mjs actions --json
//   node tools/fake-run.mjs list --path <suite> [--tags a,b] [--test-name n]
//   node tools/fake-run.mjs run --path <suite> [--trace-file f] [--results f]
//     [--format nunit3] [--tags a,b] [--test-name n] [--dry-run] [lab flags, ignored]
// list, and a dry run, print the names of the cases a run would start, one per
// line, which is what the extension shows in a lab run's confirmation.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [verb, ...args] = process.argv.slice(2);
const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const actionsDir = path.join(root, 'scripts', 'e2e', 'actions');
const registered = new Set(fs.readdirSync(actionsDir).filter(f => f.endsWith('.ps1'))
  .flatMap(f => [...fs.readFileSync(path.join(actionsDir, f), 'utf8').matchAll(/Register-(?:Suite|Lab)Action\s+-Name\s+'([^']+)'/g)].map(m => m[1])));
if (verb === 'actions') {
  process.stdout.write(JSON.stringify([...registered].sort()));
  process.exit(0);
}

const rel = opt('--path');
if (!['list', 'run'].includes(verb) || !rel) {
  process.stderr.write('usage: fake-run.mjs actions --json | list --path <suite> [--tags a,b] [--test-name n]'
    + ' | run --path <suite> [--trace-file f] [--results f] [--tags a,b] [--test-name n] [--dry-run]\n');
  process.exit(2);
}
const dryRun = verb === 'list' || args.includes('--dry-run');
const wanted = opt('--tags')?.split(',').map(t => t.trim()).filter(Boolean) ?? [];
const testName = opt('--test-name');

const list = raw => (raw ?? '').replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean);
const top = (lines, key) => lines.map(l => new RegExp(`^${key}:\\s*(.*)$`).exec(l)).find(Boolean)?.[1];

/** The items of a top-level list (`tests:` or `metaSteps:`): name, tags and their own lines. */
function items(lines, section) {
  const start = lines.findIndex(l => l.startsWith(`${section}:`));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length && !/^\S/.test(lines[i]); i++) {
    const head = /^ {2}- name:\s*(.+?)\s*$/.exec(lines[i]);
    if (head) out.push({ name: head[1], tags: [], lines: [] });
    else if (out.length) out[out.length - 1].lines.push(lines[i]);
  }
  for (const item of out) item.tags = list(item.lines.map(l => /^ {4}tags:\s*(.*)$/.exec(l)).find(Boolean)?.[1]);
  return out;
}

/** An item's steps in order: a keyword step with its action, or a meta step use. */
function steps(lines) {
  const out = [];
  for (const line of lines) {
    const keyword = /^\s*- (given|when|then|and|but):\s*(.*)$/.exec(line);
    const meta = /^\s*- meta:\s*(\S+)/.exec(line);
    const action = /^\s+action:\s*(\S+)/.exec(line);
    if (keyword) out.push({ text: `${keyword[1]}: ${keyword[2]}` });
    else if (meta) out.push({ meta: meta[1] });
    else if (action && out.length) out[out.length - 1].action = action[1];
  }
  return out;
}

/** The meta steps a file defines and imports, by name. */
function metaSteps(file, seen = new Set()) {
  if (seen.has(file)) return new Map();
  seen.add(file);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const out = new Map();
  for (const imp of list(top(lines, 'imports'))) for (const [k, v] of metaSteps(path.resolve(path.dirname(file), imp), seen)) out.set(k, v);
  for (const m of items(lines, 'metaSteps')) out.set(m.name, steps(m.lines));
  return out;
}

const file = path.resolve(root, rel);
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const suiteTags = list(top(lines, 'tags'));
const metas = metaSteps(file);
const expand = (list, depth = 0) => list.flatMap(s => (s.meta && depth < 8
  ? expand(metas.get(s.meta) ?? [{ text: `meta: ${s.meta}`, missing: true }], depth + 1).map(x => ({ ...x, text: `${s.meta} > ${x.text}` }))
  : [s]));
const cases = items(lines, 'tests')
  .filter(c => !testName || c.name === testName)
  .filter(c => !wanted.length || [...suiteTags, ...c.tags].some(t => wanted.includes(t)));

const trace = [];
const results = [];
if (!dryRun) process.stdout.write(`Demo stand-in runner: ${rel}, ${cases.length} case(s); no lab is touched.\n`);
for (const c of cases) {
  if (dryRun) {
    process.stdout.write(`${c.name}\n`);
    results.push({ name: c.name, result: 'Skipped' });
    continue;
  }
  let failure;
  for (const s of expand(steps(c.lines))) {
    if (failure) {
      trace.push({ phase: 'step', case: c.name, step: s.text, ...(s.action ? { action: s.action } : {}), status: 'skipped' });
      continue;
    }
    const reason = s.missing ? 'the meta step is not defined'
      : !s.action ? undefined
        : registered.has(s.action) ? undefined : `${s.action} is not implemented in PowerShell`;
    trace.push({ phase: 'step', case: c.name, step: s.text, ...(s.action ? { action: s.action } : {}), status: reason ? 'failed' : 'passed', ...(reason ? { reason } : {}) });
    if (reason) failure = `${s.text} failed (${reason})`;
  }
  trace.push({ phase: 'case', case: c.name, status: failure ? 'failed' : 'passed' });
  results.push({ name: c.name, result: failure ? 'Failed' : 'Passed', message: failure });
  process.stdout.write(`${failure ? 'FAIL' : 'PASS'} ${c.name}${failure ? `: ${failure}` : ''}\n`);
}

const xml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const report = [
  '<?xml version="1.0" encoding="utf-8"?>',
  `<test-run testcasecount="${results.length}">`,
  `  <test-suite type="TestSuite" name="${xml(rel)}">`,
  ...results.map(r => (r.message
    ? `    <test-case name="${xml(r.name)}" result="${r.result}"><failure><message>${xml(r.message)}</message></failure></test-case>`
    : `    <test-case name="${xml(r.name)}" result="${r.result}" />`)),
  '  </test-suite>',
  '</test-run>',
  '',
].join('\n');
const traceFile = opt('--trace-file');
const resultsFile = opt('--results');
if (traceFile) fs.writeFileSync(traceFile, JSON.stringify(trace, null, 2));
if (resultsFile) fs.writeFileSync(resultsFile, report);
process.exit(results.some(r => r.result === 'Failed') ? 1 : 0);
