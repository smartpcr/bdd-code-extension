// One suite file, read once: its value, and where each part of it is.
//
// The value is typed by the rules the Go binding's YAML reader uses (yaml.v3,
// resolved as Go's model.scalar does), not by the JS library's YAML 1.2 core
// schema, because the corpus holds the bindings to one reading: `017` is
// octal, `1e3` is a float, `.inf` is text and a quoted scalar is always text.
// The parser runs with the failsafe schema so every scalar arrives as the
// characters written, and this module types them.
import { isAlias, isMap as isYamlMap, isPair, isScalar, isSeq, LineCounter, parseDocument, Scalar } from 'yaml';
import type { Node as YamlNode } from 'yaml';
import { parseDecimalInt, parseGoFloat, parseGoInt, Value } from './value.js';

/** A one-based place in a file. */
export interface Pos {
  line: number;
  column: number;
}

/** Where a value and the key that names it are. A sequence item's key is the item. */
export interface NodePos {
  key: Pos;
  value: Pos;
}

export interface Document {
  value: Value;
  positions: Map<string, NodePos>;
}

export const START: Pos = { line: 1, column: 1 };

/** Why a file cannot be read as YAML. Always E100, always at 1:1. */
export class LoadError extends Error {}

/** One JSON pointer segment, escaped. */
export const escape = (segment: string): string => segment.replace(/~/g, '~0').replace(/\//g, '~1');
export const child = (parent: string, segment: string | number): string => `${parent}/${escape(String(segment))}`;

/** The position of a pointer, or the start of the file when it names nothing: a finding always has a place. */
export function at(doc: Document, pointer: string): NodePos {
  return doc.positions.get(pointer) ?? { key: START, value: START };
}

const NULLS = new Set(['', '~', 'null', 'Null', 'NULL']);
const TRUES = new Set(['true', 'True', 'TRUE']);
const FALSES = new Set(['false', 'False', 'FALSE']);
const YAML_FLOAT = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/;

/**
 * What a plain (unquoted) scalar names. yaml.v3 tags it first (null, bool,
 * int with any base prefix or a leading 0, float in YAML's float form) and
 * Go's model then reads the tagged text; text that is none of those is tried
 * as a decimal integer and as a Go float before it stays text.
 */
export function resolvePlain(s: string): Value {
  if (NULLS.has(s)) return null;
  if (TRUES.has(s)) return true;
  if (FALSES.has(s)) return false;
  if (/^[-+]?[0-9.]/.test(s)) {
    const asInt = parseGoInt(s);
    if (asInt !== undefined) return asInt;
    const plain = s.replace(/_/g, '');
    if (YAML_FLOAT.test(plain)) {
      const f = parseGoFloat(s);
      if (f !== undefined) return f;
    }
  }
  const decimal = parseDecimalInt(s);
  if (decimal !== undefined) return decimal;
  const f = parseGoFloat(s);
  return f !== undefined ? f : s;
}

/** Reads one suite file; throws LoadError for anything that is not one YAML document. */
export function loadDocument(text: string): Document {
  const lineCounter = new LineCounter();
  const parsed = parseDocument(text, { schema: 'failsafe', uniqueKeys: false, keepSourceTokens: true, lineCounter, strict: false });
  if (parsed.errors.length) throw new LoadError(parsed.errors[0]!.message.split('\n')[0]!);
  const root = parsed.contents;
  if (root === null) throw new LoadError('the file holds no YAML document.');
  const positions = new Map<string, NodePos>();
  const pos = (offset: number): Pos => {
    const p = lineCounter.linePos(offset);
    return { line: Math.max(1, p.line), column: Math.max(1, p.col) };
  };
  /** An empty value has no characters; the bindings report it where its key or dash is. */
  const startOf = (node: YamlNode | null, fallback: number): number => {
    const r = node?.range;
    return r && r[1] > r[0] ? r[0] : fallback;
  };
  /** An empty sequence entry is placed one column past its dash, where yaml.v3 places it. */
  const dashBefore = (offset: number): number => {
    let i = Math.min(offset, text.length) - 1;
    while (i >= 0 && text[i] !== '-' && text[i] !== '[' && text[i] !== ',') i--;
    return i >= 0 ? i + 1 : offset;
  };

  const build = (node: unknown, pointer: string): Value => {
    if (isYamlMap(node)) {
      const out = new Map<string, Value>();
      for (const pair of node.items) {
        if (!isPair(pair)) continue;
        const keyNode = pair.key as YamlNode | null;
        const key = isScalar(keyNode) ? String(keyNode.value ?? '') : '';
        const keyPointer = child(pointer, key);
        const keyOffset = startOf(keyNode, 0);
        const valueNode = pair.value as YamlNode | null;
        positions.set(keyPointer, { key: pos(keyOffset), value: pos(startOf(valueNode, keyOffset)) });
        out.set(key, build(valueNode, keyPointer));
      }
      return out;
    }
    if (isSeq(node)) {
      return node.items.map((item, index) => {
        const itemNode = item as YamlNode | null;
        const r = itemNode?.range;
        const offset = r && r[1] > r[0] ? r[0] : dashBefore(r ? r[0] : startOf(node, 0));
        const p = pos(offset);
        const itemPointer = child(pointer, index);
        positions.set(itemPointer, { key: p, value: p });
        return build(itemNode, itemPointer);
      });
    }
    // An alias resolves to nothing: the format has no use for one, and two bindings would read it differently.
    if (isAlias(node)) return null;
    if (isScalar(node)) return scalar(node);
    return null;
  };

  const value = build(root, '');
  const rootPos = pos(startOf(root as YamlNode, 0));
  positions.set('', { key: rootPos, value: rootPos });
  return { value, positions };
}

function scalar(node: Scalar): Value {
  const raw = node.value === null || node.value === undefined ? '' : String(node.value);
  // Anything quoted or written as a block, and anything tagged !!str, is text whatever it looks like.
  if (node.type !== Scalar.PLAIN || node.tag === 'tag:yaml.org,2002:str' || node.tag === '!!str') return raw;
  return resolvePlain(raw);
}
