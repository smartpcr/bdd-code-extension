// YAML parsed once with source positions (plan B1.2).
import { Document, isMap, isScalar, isSeq, LineCounter, Node, parseDocument, YAMLMap, Pair } from 'yaml';
import { LineIndex, Range } from './text';

export interface ParsedYaml {
  doc: Document;
  lines: LineCounter;
  index: LineIndex;
  /** Range of a node, or of a whole-text fallback when the node has none. */
  range(node: Node | null | undefined): Range;
  /** The first parse error, with its range. */
  error?: { message: string; range: Range };
}

export function parseYaml(text: string): ParsedYaml {
  const lines = new LineCounter();
  const doc = parseDocument(text, { keepSourceTokens: true, lineCounter: lines, uniqueKeys: false });
  const index = new LineIndex(text);
  const range = (node: Node | null | undefined): Range => {
    const r = node?.range;
    return r ? index.range(r[0], r[1]) : index.range(0, 0);
  };
  const first = doc.errors[0];
  const error = first && { message: first.message.split('\n')[0], range: index.range(first.pos[0], first.pos[1]) };
  return { doc, lines, index, range, error };
}

/** The pair whose scalar key is `key`, if the node is a map. */
export function pairOf(map: unknown, key: string): Pair<unknown, unknown> | undefined {
  if (!isMap(map)) return undefined;
  return (map as YAMLMap).items.find(p => isScalar(p.key) && p.key.value === key) as Pair<unknown, unknown> | undefined;
}

/** The value node under `key`. */
export function valueOf(map: unknown, key: string): Node | undefined {
  const v = pairOf(map, key)?.value;
  return v === null || v === undefined ? undefined : (v as Node);
}

/** The scalar string under `key`. */
export function stringOf(map: unknown, key: string): string | undefined {
  const v = valueOf(map, key);
  return isScalar(v) && typeof v.value === 'string' ? v.value : undefined;
}

/** Every item of the sequence under `key` (empty when absent or not a sequence). */
export function itemsOf(map: unknown, key: string): unknown[] {
  const v = valueOf(map, key);
  return isSeq(v) ? v.items : [];
}

/** Scalar string items of a sequence node. */
export function stringItems(node: unknown): string[] {
  return isSeq(node) ? node.items.filter(isScalar).map(s => String(s.value)) : [];
}
