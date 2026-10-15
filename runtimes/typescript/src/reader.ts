// Every file the binding reads goes through a Reader it was given (TS-5): the
// disk for the program, the editor's unsaved text first for createLinter().
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Reader {
  /** The file's text, or undefined when there is no such file. */
  read(file: string): string | undefined;
}

export const diskReader: Reader = {
  read(file) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  },
};

/** Reads `overlays` first (keyed by absolute path, compared case-insensitively on Windows), then `base`. */
export function overlayReader(overlays: Record<string, string>, base: Reader = diskReader): Reader {
  const norm = (f: string) => {
    const r = path.resolve(f);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const held = new Map(Object.entries(overlays).map(([k, v]) => [norm(k), v]));
  return { read: file => held.get(norm(file)) ?? base.read(file) };
}
