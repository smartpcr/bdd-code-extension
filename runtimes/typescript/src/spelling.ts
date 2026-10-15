// "Did you mean": the nearest legal word by edit distance, ignoring case.

/** Levenshtein distance between two words, compared in lower case. */
export function distance(left: string, right: string): number {
  const a = [...left.toLowerCase()];
  const b = [...right.toLowerCase()];
  if (a.join('') === b.join('')) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = b.map((_, i) => i).concat(b.length);
  for (let i = 0; i < a.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < b.length; j++) {
      current.push(Math.min(current[j]! + 1, previous[j + 1]! + 1, previous[j]! + (a[i] === b[j] ? 0 : 1)));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * The candidate nearest the word within maxDistance; a tie goes to the one
 * that sorts first, so every binding suggests the same word. When none is
 * near, the shortest candidate (then the first in order) that starts with the
 * word or that the word starts with, sharing at least four characters.
 */
export function nearest(word: string, candidates: readonly string[], maxDistance: number): string {
  if (!word) return '';
  const named = candidates.filter(Boolean);
  let best = '';
  let bestDistance = maxDistance + 1;
  for (const candidate of named) {
    const d = distance(word, candidate);
    if (d > maxDistance) continue;
    if (!best || d < bestDistance || (d === bestDistance && candidate < best)) {
      best = candidate;
      bestDistance = d;
    }
  }
  if (best) return best;
  const lower = word.toLowerCase();
  const byLength = [...named].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  for (const candidate of byLength) {
    const other = candidate.toLowerCase();
    if (Math.min(lower.length, other.length) < 4) continue;
    if (other.startsWith(lower) || lower.startsWith(other)) return candidate;
  }
  return '';
}
