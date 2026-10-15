// The canonical form of a report (test/e2e/conformance/report/canonicalise.md),
// written for this binding's tests from that page: volatile attributes and
// stack traces dropped, JUnit failure text dropped, attributes sorted, line
// endings, trailing space and empty text normalised, two spaces per level,
// and a JSON object line rewritten with its keys sorted.

const VOLATILE_ATTRIBUTES = new Set(['start-time', 'end-time', 'duration', 'time', 'timestamp', 'hostname', 'id', 'clr-version', 'engine-version']);
const VOLATILE_ELEMENTS = new Set(['stack-trace']);
const TEXTLESS_ELEMENTS = new Set(['failure']);

interface Element {
  name: string;
  attributes: [string, string][];
  children: Element[];
  text: string;
}

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Just enough XML for a report: elements, attributes in double quotes, text; declarations and comments skipped. */
export function parseXml(document: string): Element {
  const stack: Element[] = [];
  let root: Element | undefined;
  let at = 0;
  while (at < document.length) {
    if (document[at] !== '<') {
      const end = document.indexOf('<', at);
      const stop = end < 0 ? document.length : end;
      if (stack.length) stack[stack.length - 1]!.text += unescape(document.slice(at, stop));
      at = stop;
      continue;
    }
    const close = document.indexOf('>', at);
    const tag = document.slice(at + 1, close < 0 ? document.length : close);
    at = close < 0 ? document.length : close + 1;
    if (tag.startsWith('?') || tag.startsWith('!')) continue;
    if (tag.startsWith('/')) {
      const finished = stack.pop();
      if (!finished || finished.name !== tag.slice(1).trim()) throw new Error(`tags are not balanced at </${tag.slice(1)}>`);
      if (stack.length) stack[stack.length - 1]!.children.push(finished);
      else root = finished;
      continue;
    }
    const empty = tag.endsWith('/');
    const body = empty ? tag.slice(0, -1) : tag;
    const space = body.search(/\s/);
    const element: Element = {
      name: (space < 0 ? body : body.slice(0, space)).trim(), children: [], text: '',
      attributes: [...(space < 0 ? '' : body.slice(space)).matchAll(/([^\s=]+)="([^"]*)"/g)].map(m => [m[1]!, unescape(m[2]!)]),
    };
    if (empty) {
      if (stack.length) stack[stack.length - 1]!.children.push(element);
      else root = element;
    } else stack.push(element);
  }
  if (!root) throw new Error('a report has a root element');
  return root;
}

/** Keys sorted at every level, as the page asks; arrays keep their order. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

function sortedJsonLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return line;
  try {
    return JSON.stringify(sortKeys(JSON.parse(trimmed)));
  } catch {
    return line;
  }
}

function lines(e: Element, depth: number, out: string[]): void {
  const indent = '  '.repeat(depth);
  const attributes = e.attributes.filter(([k]) => !VOLATILE_ATTRIBUTES.has(k)).map(([k, v]) => `${k}="${v.replace(/\r\n/g, '\n')}"`).sort();
  const open = attributes.length ? `${e.name} ${attributes.join(' ')}` : e.name;
  const children = e.children.filter(c => !VOLATILE_ELEMENTS.has(c.name));
  const text = TEXTLESS_ELEMENTS.has(e.name) ? '' : e.text.replace(/\r\n/g, '\n').trim().split('\n').map(sortedJsonLine).join('\n');
  if (!children.length && !text) {
    out.push(`${indent}<${open}/>`);
    return;
  }
  if (!children.length) {
    const flat = text.split('\n').map(l => l.replace(/[ \t]+$/, ''));
    if (flat.length === 1) out.push(`${indent}<${open}>${flat[0]}</${e.name}>`);
    else out.push(`${indent}<${open}>`, ...flat.map(l => `${'  '.repeat(depth + 1)}${l}`), `${indent}</${e.name}>`);
    return;
  }
  out.push(`${indent}<${open}>`);
  if (text) out.push(`${'  '.repeat(depth + 1)}${text}`);
  for (const c of children) lines(c, depth + 1, out);
  out.push(`${indent}</${e.name}>`);
}

export function canonicalise(document: string): string {
  const out: string[] = [];
  lines(parseXml(document), 0, out);
  return `${out.join('\n')}\n`;
}
