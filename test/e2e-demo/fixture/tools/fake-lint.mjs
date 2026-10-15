// A small stand-in for `suiterun lint`, so the demo needs no real binding
// built. It speaks the same command line and JSON (DEC-Y14) and checks each
// step against the catalog with the codes the bindings' lint uses:
//   E104  unknown action (with the nearest name as a suggestion)
//   E102  a required parameter is missing        (at the step)
//   E105  a parameter the action does not take   (at the key; nearest parameter suggested)
//   E103  a parameter of the wrong type          (at the value)
//   E206  a meta step that is not declared or imported
//   E208  a meta step use without a required parameter, or with one it does not take
// Usage, as the extension calls it from the workspace root:
//   node tools/fake-lint.mjs lint --path <suite> --json --binding-check --binding <b>
import * as fs from 'node:fs';
import * as path from 'node:path';
import { flowMap, readCatalog, stepEnvelope } from './catalog.mjs';

const args = process.argv.slice(2);
if (args[0] !== 'lint' || !args.includes('--path')) {
  process.stderr.write('usage: fake-lint.mjs lint --path <suite> --json\n');
  process.exit(2);
}
const rel = args[args.indexOf('--path') + 1];
const { actions } = readCatalog();
const common = new Set(Object.keys(stepEnvelope()));
const file = rel.split(path.sep).join('/');
const findings = [];
const report = (code, line, column, message, suggestion) =>
  findings.push({ code, severity: 'error', file, line, column, message, ...(suggestion ? { suggestion } : {}) });

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
const nearest = (word, options) => {
  const best = [...options].map(o => [o, distance(word, o)]).sort((x, y) => x[1] - y[1])[0];
  return best && best[1] <= Math.max(2, Math.floor(word.length / 3)) ? `Did you mean ${best[0]}?` : undefined;
};

/** The type a scalar written in YAML has. */
function typeOf(raw) {
  const v = raw.replace(/\s+#.*$/, '').trim();
  if (v === '') return 'object';
  if (/^\$\{[^}]+\}$/.test(v)) return 'expression';
  if (/^['"]/.test(v)) return 'string';
  if (v.startsWith('{')) return 'object';
  if (v.startsWith('[')) return 'array';
  if (/^(true|false)$/.test(v)) return 'boolean';
  if (/^-?\d+$/.test(v)) return 'integer';
  if (/^-?\d+\.\d+$/.test(v)) return 'number';
  return 'string';
}
const fits = (declared, actual) => actual === 'expression' || declared === 'any' || declared === actual
  || (declared === 'number' && actual === 'integer');

/**
 * Each step of a file: a list item under a `steps:` key, with its keys at the
 * item's own indentation (one-based line and column), and `with:` read as a
 * flow mapping or a block of keys below it.
 */
function stepsOf(lines) {
  const out = [];
  let stepsIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (stepsIndent >= 0 && indent <= stepsIndent && !line.trimStart().startsWith('- ')) stepsIndent = -1;
    if (stepsIndent >= 0 && indent < stepsIndent) stepsIndent = -1;
    const steps = /^(\s*)(?:- )?steps:\s*$/.exec(line);
    if (steps) {
      stepsIndent = line.indexOf('steps:');
      continue;
    }
    const item = /^(\s*)- (\w+):\s*(.*)$/.exec(line);
    if (stepsIndent < 0 || !item || item[1].length < stepsIndent) continue;
    const keyIndent = item[1].length + 2;
    const step = { line: i + 1, column: keyIndent + 1, keys: [] };
    step.keys.push({ name: item[2], line: i + 1, column: keyIndent + 1, value: item[3], valueColumn: line.indexOf(item[3], keyIndent + item[2].length) + 1 });
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = lines[j];
      if (!next.trim()) continue;
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent < keyIndent) break;
      const key = /^\s*(\w+):\s*(.*)$/.exec(next);
      if (nextIndent === keyIndent && key) {
        step.keys.push({ name: key[1], line: j + 1, column: keyIndent + 1, value: key[2], valueColumn: next.indexOf(key[2], keyIndent + key[1].length) + 1, block: [] });
      } else if (step.keys.length && nextIndent > keyIndent) {
        (step.keys[step.keys.length - 1].block ??= []).push(next);
      }
    }
    out.push(step);
  }
  return out;
}

/** Meta step definitions visible from a file: its own, and those of its imports. */
function metaDefinitions(fileRel, seen = new Set()) {
  const out = new Map();
  if (seen.has(fileRel) || !fs.existsSync(fileRel)) return out;
  seen.add(fileRel);
  const text = fs.readFileSync(fileRel, 'utf8');
  const imports = /^imports:\s*\[(.*)\]/m.exec(text)?.[1].split(',').map(s => s.trim()).filter(Boolean) ?? [];
  for (const i of imports) for (const [k, v] of metaDefinitions(path.join(path.dirname(fileRel), i), seen)) out.set(k, v);
  let current;
  let inParams = false;
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = /^ {2}- name:\s*(\S+)/.exec(line)) && /^metaSteps:/m.test(text)) {
      current = { name: m[1], params: [] };
      out.set(current.name, current);
      inParams = false;
    } else if (current && /^ {4}params:\s*$/.test(line)) {
      inParams = true;
    } else if (current && inParams && (m = /^ {6}- \{(.*)\}/.exec(line))) {
      const p = flowMap(m[1]);
      current.params.push({ name: String(p.name), required: p.required === true });
    } else if (/^ {4}\S/.test(line)) {
      inParams = false;
    }
  }
  return out;
}

const lines = fs.readFileSync(rel, 'utf8').split(/\r?\n/);
const metas = metaDefinitions(rel);
for (const step of stepsOf(lines)) {
  const key = name => step.keys.find(k => k.name === name);
  const action = key('action');
  const meta = key('meta');
  if (action) {
    const name = action.value.replace(/\s+#.*$/, '').trim();
    const entry = actions.get(name);
    if (!entry) {
      report('E104', action.line, action.valueColumn, `Unknown action ${name}: the catalog does not declare it.`, nearest(name, actions.keys()));
      continue;
    }
    const params = new Map(entry.params.map(p => [p.name, p]));
    for (const p of entry.params) {
      if (p.required && !key(p.name)) report('E102', step.line, step.column, `${name} needs the parameter ${p.name}${p.description ? ` (${p.description})` : ''}.`);
    }
    for (const k of step.keys) {
      if (k.name === 'action' || common.has(k.name)) continue;
      const p = params.get(k.name);
      if (!p) {
        report('E105', k.line, k.column, `${name} takes no parameter ${k.name}; it takes ${entry.params.map(x => x.name).join(', ') || 'none'}.`, nearest(k.name, params.keys()));
      } else if (!fits(p.type, typeOf(k.value))) {
        report('E103', k.line, k.valueColumn, `${name}'s ${k.name} is ${p.type === 'integer' ? 'an' : 'a'} ${p.type}, not ${typeOf(k.value) === 'integer' ? 'an' : 'a'} ${typeOf(k.value)}.`);
      }
    }
  } else if (meta) {
    const name = meta.value.trim();
    const def = metas.get(name);
    if (!def) {
      report('E206', meta.line, meta.valueColumn, `No meta step named ${name} is declared or imported.`, nearest(name, metas.keys()));
      continue;
    }
    const withKey = key('with');
    const given = new Map();
    if (withKey) {
      if (withKey.value.trim().startsWith('{')) {
        for (const m of withKey.value.matchAll(/(\w+)\s*:/g)) given.set(m[1], { line: withKey.line, column: withKey.valueColumn + m.index });
      } else {
        for (const b of withKey.block ?? []) {
          const m = /^(\s*)(\w+):/.exec(b);
          if (m) given.set(m[2], { line: withKey.line + 1 + (withKey.block ?? []).indexOf(b), column: m[1].length + 1 });
        }
      }
    }
    for (const p of def.params) if (p.required && !given.has(p.name)) report('E208', meta.line, meta.valueColumn, `The meta step ${name} needs the parameter ${p.name} in with:.`);
    for (const [g, at] of given) {
      if (!def.params.some(p => p.name === g)) report('E208', at.line, at.column, `The meta step ${name} takes no parameter ${g}.`, nearest(g, def.params.map(p => p.name)));
    }
  }
}
findings.sort((a, b) => a.line - b.line || a.column - b.column);
process.stdout.write(JSON.stringify(findings));
process.exit(findings.length ? 2 : 0);
