// Where a workspace's schema is, and which files a --path names.
//
// The workspace root is found by walking up to test/e2e/schema (the layout a
// workspace uses by default), so the runtime works from any working directory;
// --schema-root names another place.
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The nearest ancestor of start (itself included) that holds test/e2e/schema. */
export function repositoryRoot(start: string): string | undefined {
  let here = path.resolve(start);
  for (;;) {
    if (isDirectory(path.join(here, 'test', 'e2e', 'schema'))) return here;
    const parent = path.dirname(here);
    if (parent === here) return undefined;
    here = parent;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Where suite.schema.json and actions.catalog.yaml are. */
export const schemaRoot = (root: string): string => path.join(root, 'test', 'e2e', 'schema');


/**
 * Whether a file name matches a --path glob: `*` is any run of characters and
 * `?` is one; nothing else is special. Two characters are the whole
 * vocabulary every binding shares, so `**` or `[a-z]` mean themselves here
 * rather than something the other bindings would not accept.
 */
export function matchesGlob(pattern: string, name: string): boolean {
  const p = [...pattern];
  const n = [...name];
  let atP = 0;
  let atN = 0;
  let star = -1;
  let starAtN = 0;
  while (atN < n.length) {
    if (atP < p.length && (p[atP] === '?' || p[atP] === n[atN])) {
      atP++;
      atN++;
    } else if (atP < p.length && p[atP] === '*') {
      star = atP++;
      starAtN = atN;
    } else if (star >= 0) {
      atP = star + 1;
      atN = ++starAtN;
    } else {
      return false;
    }
  }
  while (atP < p.length && p[atP] === '*') atP++;
  return atP === p.length;
}

/**
 * Every file a --path names, sorted so two machines run them in one order. A
 * pattern is a directory and a last segment; only the last segment may hold
 * `*` or `?`. A name with neither must be an existing file.
 */
export function resolveGlob(pattern: string, cwd: string): string[] {
  const full = path.resolve(cwd, pattern.replace(/\\/g, '/'));
  const leaf = path.basename(full);
  if (!/[*?]/.test(leaf)) {
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return [full];
    throw new Error(`${pattern} names no file`);
  }
  const dir = path.dirname(full);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`${dir} cannot be read: ${(e as Error).message}`);
  }
  const found = entries.filter(e => e.isFile() && matchesGlob(leaf, e.name)).map(e => path.join(dir, e.name))
    .sort();
  if (!found.length) throw new Error(`${pattern} names no file`);
  return found;
}
