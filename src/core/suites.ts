// Suites and libraries, indexed with positions (plan B1.3). The walker recurses
// explicitly so it always knows where a step sits (its home).
import * as path from 'path';
import { isMap, isScalar, isSeq, Node, Pair } from 'yaml';
import {
  CaseInfo, HookName, Keyword, MetaStepDef, Named, StepHome, StepInfo, SuiteFile,
} from './types';
import { itemsOf, ParsedYaml, parseYaml, stringItems, stringOf, valueOf } from './yamlPositions';

const KEYWORDS: Keyword[] = ['given', 'when', 'then', 'and'];
/** Step keys that are not action parameters. */
const STRUCTURAL = new Set(['action', 'meta', 'with', 'captureAs', 'table', 'forStep', ...KEYWORDS]);
const SUITE_HOOKS: HookName[] = ['setup', 'teardown', 'beforeEach', 'afterEach'];

/** Offsets [start, end) of every ${...} in `src`, honouring nested braces and quoted strings. */
export function findExpressions(src: string): [number, number][] {
  const out: [number, number][] = [];
  let i = src.indexOf('${');
  while (i !== -1) {
    let depth = 1;
    let j = i + 2;
    for (; j < src.length && depth > 0; j++) {
      const c = src[j];
      if (c === '"' || c === "'") {
        j++;
        while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      } else if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    if (depth !== 0) break;
    out.push([i, j]);
    i = src.indexOf('${', j);
  }
  return out;
}

function namedKeys(node: unknown, y: ParsedYaml): Named[] {
  if (!isMap(node)) return [];
  return node.items.filter(p => isScalar(p.key))
    .map(p => ({ name: String((p.key as Node & { value: unknown }).value), range: y.range(p.key as Node) }));
}

function namesOfItems(node: unknown): string[] {
  return isSeq(node) ? node.items.map(i => stringOf(i, 'name')).filter((n): n is string => n !== undefined) : [];
}

class Walker {
  readonly steps: StepInfo[] = [];
  constructor(private readonly y: ParsedYaml, private readonly text: string, private readonly file: string) {}

  /** Every scalar's ${...} beneath `node`, skipping nested forStep (its own step). */
  private expressions(node: unknown, out: StepInfo['expressions']): void {
    if (isScalar(node)) {
      const r = node.range;
      if (r && typeof node.value === 'string') {
        for (const [s, e] of findExpressions(this.text.slice(r[0], r[1]))) {
          out.push({ text: this.text.slice(r[0] + s, r[0] + e), range: this.y.index.range(r[0] + s, r[0] + e) });
        }
      }
    } else if (isMap(node)) {
      for (const p of node.items) {
        if (isScalar(p.key) && p.key.value === 'forStep') continue;
        this.expressions(p.value, out);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) this.expressions(item, out);
    }
  }

  step(node: unknown, home: StepHome): void {
    if (!isMap(node)) return;
    const y = this.y;
    const info: StepInfo = {
      file: this.file, range: y.range(node), index: this.steps.length, home,
      withKeys: [], params: [], expressions: [],
    };
    for (const pair of node.items as Pair<unknown, unknown>[]) {
      if (!isScalar(pair.key)) continue;
      const key = String(pair.key.value);
      const value = pair.value as Node | null;
      if ((KEYWORDS as string[]).includes(key)) {
        if (info.keyword === undefined) {
          info.keyword = key as Keyword;
          info.sentence = isScalar(value) ? String(value.value) : undefined;
        }
      } else if (key === 'action' && isScalar(value)) {
        info.action = String(value.value);
        info.actionRange = y.range(value);
      } else if (key === 'meta' && isScalar(value)) {
        info.meta = String(value.value);
        info.metaRange = y.range(value);
      } else if (key === 'with') {
        info.withKeys = namedKeys(value, y);
      } else if (key === 'captureAs' && isScalar(value)) {
        info.captureAs = String(value.value);
        info.captureAsRange = y.range(value);
      } else if (key === 'table') {
        info.tableColumns = isSeq(value) ? namedKeys(value.items[0], y).map(k => k.name) : [];
      } else if (!STRUCTURAL.has(key)) {
        info.params.push({ name: key, range: y.range(pair.key as Node), value: value ? value.toJSON() : null });
      }
    }
    this.expressions(node, info.expressions);
    this.steps.push(info);
    const nested = valueOf(node, 'forStep');
    if (nested) this.step(nested, home);
  }

  list(node: unknown, home: StepHome): void {
    if (isSeq(node)) for (const item of node.items) this.step(item, home);
  }
}

function emptySuite(file: string): SuiteFile {
  return { file, hasSuiteKey: false, imports: [], params: [], vars: [], metaSteps: [], cases: [], steps: [] };
}

export function parseSuite(text: string, file: string): SuiteFile {
  const y = parseYaml(text);
  const suite = emptySuite(file);
  if (y.error) {
    suite.parseError = { code: 'BDD030', message: `Not valid YAML: ${y.error.message}`, range: y.error.range };
    return suite;
  }
  const root = y.doc.contents;
  if (!isMap(root)) {
    suite.notAMapping = true;
    return suite;
  }
  const w = new Walker(y, text, file);
  suite.hasSuiteKey = root.items.some(p => isScalar(p.key) && p.key.value === 'suite');
  suite.suiteName = stringOf(root, 'suite');
  for (const item of itemsOf(root, 'imports')) {
    if (!isScalar(item)) continue;
    const p = String(item.value);
    suite.imports.push({ path: p, resolved: path.resolve(path.dirname(file), p), range: y.range(item) });
  }
  for (const item of itemsOf(root, 'params')) {
    const nameNode = valueOf(item, 'name');
    if (isScalar(nameNode)) suite.params.push({ name: String(nameNode.value), range: y.range(nameNode) });
  }
  suite.vars.push(...namedKeys(valueOf(root, 'vars'), y));
  for (const hook of SUITE_HOOKS) w.list(valueOf(root, hook), { kind: 'hook', hook });
  for (const item of itemsOf(root, 'metaSteps')) {
    const nameNode = valueOf(item, 'name');
    if (!isScalar(nameNode)) continue;
    const def: MetaStepDef = {
      name: String(nameNode.value),
      range: y.range(item as Node),
      nameRange: y.range(nameNode),
      params: namesOfItems(valueOf(item, 'params')),
      exports: stringItems(valueOf(item, 'exports')),
    };
    suite.metaSteps.push(def);
    w.list(valueOf(item, 'steps'), { kind: 'meta', metaName: def.name });
  }
  itemsOf(root, 'tests').forEach((item, caseIndex) => {
    if (!isMap(item)) return;
    const caseName = stringOf(item, 'name') ?? `#${caseIndex + 1}`;
    const examples = valueOf(item, 'examples');
    const info: CaseInfo = {
      name: caseName,
      range: y.range(item),
      tags: stringItems(valueOf(item, 'tags')),
      examplesRows: isSeq(examples) ? examples.items.length : 0,
      examplesColumns: isSeq(examples) ? namedKeys(examples.items[0], y).map(k => k.name) : undefined,
      params: namesOfItems(valueOf(item, 'params')),
    };
    suite.cases.push(info);
    suite.vars.push(...namedKeys(valueOf(item, 'vars'), y).map(v => ({ ...v, caseName })));
    w.list(valueOf(item, 'setup'), { kind: 'hook', hook: 'setup', caseName });
    w.list(valueOf(item, 'steps'), { kind: 'case', caseName, caseIndex });
    w.list(valueOf(item, 'cleanup'), { kind: 'hook', hook: 'cleanup', caseName });
  });
  suite.steps = w.steps;
  return suite;
}
