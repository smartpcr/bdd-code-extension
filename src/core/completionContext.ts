// Line contexts for completion (plan B3.1, B3.5): what kind of value is being
// typed, from the text before the cursor. Pure, so it is unit-tested.

/** After `action:` (block or `- action:`), the partial name. */
export function actionPrefix(lineBefore: string): string | undefined {
  return /^\s*(?:-\s+)?action:\s*(\S*)$/.exec(lineBefore)?.[1];
}

/**
 * What choosing an action from completion inserts: its name and, on the lines
 * below at the step's key indentation, each required parameter the step does not
 * already have, with a tab stop for its value. `keyColumn` is where `action:`
 * starts on its line. Returned as snippet text ($1, $2, ...; `$` and `}` escaped).
 */
export function requiredParamsSnippet(action: string, required: string[], keyColumn: number, present: Set<string>, eol = '\n'): string {
  const esc = (s: string) => s.replace(/[$}\\]/g, m => `\\${m}`);
  const lines = required.filter(p => !present.has(p)).map((p, i) => `${eol}${' '.repeat(keyColumn)}${esc(p)}: $${i + 1}`);
  return esc(action) + lines.join('');
}

/**
 * The keys, with their values as written, of the step whose keys sit at
 * `keyColumn` around `line`: up to the step's `- ` line and down to its end,
 * past nested values. `item` says whether a `- ` line was found, that is,
 * whether this is a list item (a step) at all. `line` itself counts only when
 * it holds a key.
 */
export function stepAtColumn(lines: string[], line: number, keyColumn: number): { keys: Map<string, string>; item: boolean } {
  const keys = new Map<string, string>();
  const keyAt = (text: string) => /^(\s*)(?:-\s+)?([\w-]+):\s*(.*)$/.exec(text);
  // Where a line's first key starts: after `- ` on an item line.
  const columnOf = (text: string) => (/^\s*-\s+/.exec(text) ?? /^\s*/.exec(text)!)[0].length;
  let item = false;
  for (let i = line; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    const column = columnOf(lines[i]);
    if (column > keyColumn) continue;
    const k = keyAt(lines[i]);
    if (column < keyColumn || !k) {
      if (i === line) continue;
      break;
    }
    keys.set(k[2], k[3]);
    if (/^\s*-\s+/.test(lines[i])) {
      item = true;
      break;
    }
  }
  for (let i = line + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const indent = /^\s*/.exec(lines[i])![0].length;
    if (indent > keyColumn) continue;
    const k = keyAt(lines[i]);
    if (indent < keyColumn || !k || /^\s*-\s+/.test(lines[i])) break;
    keys.set(k[2], k[3]);
  }
  return { keys, item };
}

/**
 * The keys of the step whose `action:` is on `line`: the keys at the same
 * indentation from the step's `- ` line down to the step's end.
 */
export function stepKeysAround(lines: string[], line: number): { keyColumn: number; keys: Set<string> } {
  const m = /^(\s*)(-\s+)?action:/.exec(lines[line]);
  const keyColumn = m ? m[1].length + (m[2]?.length ?? 0) : 0;
  return { keyColumn, keys: new Set(stepAtColumn(lines, line, keyColumn).keys.keys()) };
}

/**
 * A key position in an item of an `asserts:` list, on a line of its own under
 * the item or right after its `- `: the partial key, where it starts, and the
 * keys the item already has. Undefined anywhere else.
 */
export function assertKeyPrefix(lines: string[], line: number, character: number):
  { typed: string; start: number; present: Set<string> } | undefined {
  const m = /^(\s*)(-\s+)?([\w-]*)$/.exec(lines[line].slice(0, character));
  if (!m || (!m[1] && !m[2])) return undefined;
  const column = m[1].length + (m[2]?.length ?? 0);
  const present = new Set<string>();
  const keyAt = (text: string) => /^\s*(?:-\s+)?([\w-]+):/.exec(text)?.[1];
  let dash = m[2] ? line : -1;
  for (let i = line - 1; i >= 0 && dash < 0; i--) {
    const text = lines[i];
    if (!text.trim()) continue;
    const at = (/^\s*-\s+/.exec(text) ?? /^\s*/.exec(text)!)[0].length;
    if (at > column) continue;
    const key = keyAt(text);
    if (at < column || !key) return undefined;
    present.add(key);
    if (/^\s*-\s/.test(text)) dash = i;
  }
  if (dash < 0) return undefined;
  for (let i = line + 1; i < lines.length; i++) {
    const text = lines[i];
    if (!text.trim()) continue;
    const indent = /^\s*/.exec(text)![0].length;
    if (indent > column) continue;
    const key = keyAt(text);
    if (indent < column || !key || /^\s*-\s/.test(text)) break;
    present.add(key);
  }
  const dashIndent = /^\s*/.exec(lines[dash])![0].length;
  for (let i = dash - 1; i >= 0; i--) {
    const text = lines[i];
    if (!text.trim() || /^\s*/.exec(text)![0].length >= dashIndent) continue;
    return /^\s*(?:-\s+)?asserts:\s*$/.test(text) ? { typed: m[3], start: character - m[3].length, present } : undefined;
  }
  return undefined;
}

/** On a line that is only indentation and a partial key: where the key starts and what is typed. */
export function keyPrefix(lineBefore: string): { column: number; typed: string } | undefined {
  const m = /^(\s+)([\w-]*)$/.exec(lineBefore);
  return m ? { column: m[1].length, typed: m[2] } : undefined;
}

/** After `meta:`, the partial meta step name. */
export function metaPrefix(lineBefore: string): string | undefined {
  return /^\s*(?:-\s+)?meta:\s*([\w.-]*)$/.exec(lineBefore)?.[1];
}

/**
 * After `var:` in an item of an `asserts:` list: the subject typed so far, a
 * dotted path into the capture bag, as the segments before the last dot, the
 * partial last one, and the column it starts at. Undefined anywhere else.
 */
export function assertSubjectPrefix(lines: string[], line: number, character: number):
  { segments: string[]; prefix: string; start: number } | undefined {
  const m = /^(\s*)(-\s+)?var:\s+((?:\w+\.)*)(\w*)$/.exec(lines[line].slice(0, character));
  if (!m) return undefined;
  const column = m[1].length + (m[2]?.length ?? 0);
  let dash = m[2] ? m[1].length : -1;
  for (let i = line - 1; i >= 0; i--) {
    const text = lines[i];
    if (!text.trim()) continue;
    const own = /^\s*/.exec(text)![0].length;
    if (dash < 0) {
      if (own >= column) continue;
      if (!/^\s*-\s/.test(text)) return undefined;
      dash = own;
    } else if (own < dash) {
      if (!/^\s*(?:-\s+)?asserts:\s*$/.test(text)) return undefined;
      return { segments: m[3].split('.').filter(Boolean), prefix: m[4], start: character - m[4].length };
    }
  }
  return undefined;
}

/**
 * A key position inside a `with:` map: flow style (`with: { a: 1, |`) or a
 * block line under `with:`. Returns the partial key, or undefined.
 */
export function withKeyPrefix(lines: string[], line: number, character: number): string | undefined {
  const before = lines[line].slice(0, character);
  const flow = /with:\s*\{(?:[^}]*,)?\s*([\w-]*)$/.exec(before);
  if (flow) return flow[1];
  const block = /^(\s*)([\w-]*)$/.exec(before);
  if (!block) return undefined;
  const indent = block[1].length;
  for (let i = line - 1; i >= 0; i--) {
    const text = lines[i];
    if (!text.trim()) continue;
    const own = /^\s*/.exec(text)![0].length;
    if (own >= indent) continue;
    return /^\s*(?:-\s+)?with:\s*$/.test(text) ? block[2] : undefined;
  }
  return undefined;
}
