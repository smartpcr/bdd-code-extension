// An independent walk of suites for B1.3-1 and E-B4: it does not use the
// extension's indexer. It visits every mapping with an `action` key that sits in
// a sequence (a step list) or under `forStep`, anywhere in the document.
import * as fs from 'fs';
import * as path from 'path';
import { isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, visit } from 'yaml';

export interface OracleStep {
  file: string;
  line: number;
  action: string;
}

export function oracleSteps(file: string, text = fs.readFileSync(file, 'utf8')): OracleStep[] {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: false });
  if (doc.errors.length) return [];
  const out: OracleStep[] = [];
  visit(doc, {
    Map(_key, node, ancestors) {
      const parent = ancestors[ancestors.length - 1];
      const underForStep = isPair(parent) && isScalar(parent.key) && parent.key.value === 'forStep';
      if (!isSeq(parent) && !underForStep) return;
      // A step list is a sequence under a hook, `steps`, or `tests` is not a step list.
      if (isSeq(parent)) {
        const owner = ancestors[ancestors.length - 2];
        const key = isPair(owner) && isScalar(owner.key) ? String(owner.key.value) : '';
        if (!['steps', 'setup', 'teardown', 'beforeEach', 'afterEach', 'cleanup'].includes(key)) return;
      }
      const action = node.items.find(p => isScalar(p.key) && p.key.value === 'action');
      if (action && isScalar(action.value) && action.value.range) {
        out.push({ file, line: lines.linePos(action.value.range[0]).line - 1, action: String(action.value.value) });
      }
    },
  });
  return out;
}

/** Build output and dependencies the bindings keep under test/e2e; never suites. */
const BUILD_OUTPUT = new Set(['node_modules', 'target', 'artifacts', 'dist', 'bin', 'obj', '.git']);

/** Every .yml under test/e2e (build output excluded) that is a suite or a library a suite imports. */
export function oracleSuiteFiles(root: string): string[] {
  const all: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!BUILD_OUTPUT.has(e.name)) walk(p);
      }
      else if (e.name.endsWith('.yml')) all.push(p);
    }
  };
  walk(path.join(root, 'test', 'e2e'));
  const imported = new Set<string>();
  const suites = all.filter(f => {
    const doc = parseDocument(fs.readFileSync(f, 'utf8'));
    if (doc.errors.length || !isMap(doc.contents)) return false;
    const imp = doc.get('imports');
    if (isSeq(imp)) for (const i of imp.items) if (isScalar(i)) imported.add(path.resolve(path.dirname(f), String(i.value)).toLowerCase());
    return doc.has('suite');
  });
  return [...new Set([...suites, ...all.filter(f => imported.has(path.resolve(f).toLowerCase()))])];
}
