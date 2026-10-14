// Line contexts for completion (plan B3.1, B3.5): what kind of value is being
// typed, from the text before the cursor. Pure, so it is unit-tested.

/** After `action:` (block or `- action:`), the partial name. */
export function actionPrefix(lineBefore: string): string | undefined {
  return /^\s*(?:-\s+)?action:\s*(\S*)$/.exec(lineBefore)?.[1];
}

/** After `meta:`, the partial meta step name. */
export function metaPrefix(lineBefore: string): string | undefined {
  return /^\s*(?:-\s+)?meta:\s*([\w.-]*)$/.exec(lineBefore)?.[1];
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
