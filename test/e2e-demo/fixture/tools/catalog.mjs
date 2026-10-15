// Reads the demo workspace's catalog and step envelope, for tools/gen-schema.mjs
// and tools/fake-lint.mjs. No dependencies: the catalog's layout is fixed (one
// `  - name:` line per action, one flow mapping per parameter), so a line
// reader is enough for it.
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SCHEMA_DIR = path.join('test', 'e2e', 'schema');

/** A flow mapping `{ a: 1, b: 'x, y' }` as an object of strings, booleans and numbers. */
export function flowMap(text) {
  const out = {};
  for (const m of text.matchAll(/(\w+)\s*:\s*('([^']*)'|"([^"]*)"|[^,}]+)/g)) {
    const raw = m[3] ?? m[4] ?? m[2].trim();
    out[m[1]] = m[3] !== undefined || m[4] !== undefined ? raw
      : raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return out;
}

/** The catalog: { bindings, actions: Map<name, { name, summary, bindings, params: [{ name, type, required, description }] }> }. */
export function readCatalog(root = '.') {
  const text = fs.readFileSync(path.join(root, SCHEMA_DIR, 'actions.catalog.yaml'), 'utf8');
  const actions = new Map();
  let current;
  let inParams = false;
  const bindings = (/^bindings:\s*\[(.*)\]/m.exec(text)?.[1] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = /^ {2}- name:\s*(\S+)/.exec(line))) {
      current = { name: m[1], summary: '', bindings: [], params: [] };
      actions.set(current.name, current);
      inParams = false;
    } else if (!current) {
      continue;
    } else if ((m = /^ {4}summary:\s*(.*)$/.exec(line))) {
      current.summary = m[1].trim();
    } else if ((m = /^ {4}bindings:\s*\[(.*)\]/.exec(line))) {
      current.bindings = m[1].split(',').map(s => s.trim()).filter(Boolean);
    } else if (/^ {4}params:\s*$/.test(line)) {
      inParams = true;
    } else if (inParams && (m = /^ {6}- \{(.*)\}/.exec(line))) {
      const p = flowMap(m[1]);
      current.params.push({ name: String(p.name), type: String(p.type ?? 'any'), required: p.required === true, description: p.description ? String(p.description) : undefined });
    } else if (/^ {4}\S/.test(line)) {
      inParams = false;
    }
  }
  return { bindings, actions };
}

/** The keys every step may carry, from suite.base.json's stepEnvelope (the same list Declare action reads). */
export function stepEnvelope(root = '.') {
  const base = JSON.parse(fs.readFileSync(path.join(root, SCHEMA_DIR, 'suite.base.json'), 'utf8'));
  return base.$defs.stepEnvelope.properties;
}
