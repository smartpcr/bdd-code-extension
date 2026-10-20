// The suite files a config selects (spec/test-plan.md, Building the plan,
// step 1): ** any number of folders, * any text inside one name, ? one
// character, and .. allowed before the first wildcard. Ordinal order, paths
// relative to the config's folder with forward slashes.
import * as fs from 'node:fs';
import * as path from 'node:path';

const slashes = (p: string) => p.replace(/\\/g, '/');

/** The folder a pattern starts in (its segments before the first wildcard) and the rest. */
function split(root: string, pattern: string): { start: string; rest: string } {
  const segments = pattern.split('/');
  let fixed = 0;
  while (fixed < segments.length - 1 && !/[*?]/.test(segments[fixed]!)) fixed++;
  return { start: path.resolve(root, ...segments.slice(0, fixed)), rest: segments.slice(fixed).join('/') };
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function matcher(root: string, pattern: string): RegExp {
  const { start, rest } = split(root, pattern);
  let built = `^${escape(slashes(start).replace(/\/$/, ''))}/`;
  for (let i = 0; i < rest.length; i++) {
    const one = rest[i]!;
    if (one === '*' && rest[i + 1] === '*') {
      if (rest[i + 2] === '/') {
        built += '(?:.*/)?';
        i += 2;
      } else {
        built += '.*';
        i += 1;
      }
    } else if (one === '*') built += '[^/]*';
    else if (one === '?') built += '[^/]';
    else built += escape(one);
  }
  return new RegExp(`${built}$`, process.platform === 'win32' ? 'i' : '');
}

function filesUnder(folder: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap(e => (e.isDirectory() ? filesUnder(path.join(folder, e.name)) : [path.join(folder, e.name)]));
}

/** The files the includes match and the excludes do not, relative to folder. */
export function select(folder: string, includes: string[], excludes: string[] = []): string[] {
  const root = path.resolve(folder);
  const rejected = excludes.map(p => matcher(root, p));
  const found = new Set<string>();
  for (const pattern of includes) {
    const accept = matcher(root, pattern);
    for (const file of filesUnder(split(root, pattern).start)) {
      const full = slashes(file);
      if (accept.test(full) && !rejected.some(r => r.test(full))) found.add(slashes(path.relative(root, file)));
    }
  }
  return [...found].sort();
}
