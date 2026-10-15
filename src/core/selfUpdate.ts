// Whether a newer copy of this extension is installed than the one running.
// VS Code loads an extension's code once per extension host, so a version
// installed while the window is open runs only after a reload; the window
// offers one when this finds a newer copy. Pure: the caller lists the folder.

/** `major.minor.patch` as numbers, or undefined when it is not one. */
export function parseVersion(v: string): number[] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Positive when `a` is newer than `b`. */
function compare(a: number[], b: number[]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * The newest version of `id` among the extensions folder's entries
 * (`<publisher>.<name>-<version>`) that is newer than `running`; undefined
 * when there is none. Folders VS Code marked obsolete (removed, awaiting
 * deletion) do not count.
 */
export function newerInstalled(folders: string[], obsolete: Set<string>, id: string, running: string): string | undefined {
  const current = parseVersion(running);
  if (!current) return undefined;
  const prefix = `${id.toLowerCase()}-`;
  let best: { text: string; parts: number[] } | undefined;
  for (const folder of folders) {
    if (!folder.toLowerCase().startsWith(prefix) || obsolete.has(folder)) continue;
    const text = folder.slice(prefix.length);
    const parts = parseVersion(text);
    if (parts && compare(parts, best?.parts ?? current) > 0) best = { text, parts };
  }
  return best?.text;
}
