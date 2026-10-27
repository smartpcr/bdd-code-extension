// Path arithmetic without Node's `path`, so src/core also builds for a browser
// (the language package, packages/language). On a Node host it answers as
// Node's `path` does on that platform: Windows rules on win32, POSIX elsewhere,
// relative paths against process.cwd(). With no `process` (a browser) it is
// POSIX and a relative path resolves against /. A path that starts with a drive
// letter or a backslash is read by Windows rules on any host, so a Windows path
// handed to a browser still resolves.
//
// Departures from Node, none of which VS Code's paths reach: a drive-relative
// path (`C:x`) on another drive than the working folder resolves against that
// drive's root (Node first reads the `=C:` environment variable), and on a POSIX
// host a path starting with a drive letter or a backslash is a Windows path
// rather than a relative name.

/** What the host says about paths: whether it is Windows, and the working folder. */
export interface PathHost {
  windows: boolean;
  /** The folder a relative path resolves against; undefined when the host has none. */
  cwd(): string | undefined;
}

/** The host a global object describes: Node's `process`, or none (a browser). */
export function hostOf(scope: object): PathHost {
  // Read off the object, so the module needs no Node types: a browser build has none.
  const proc = (scope as { process?: { platform?: unknown; cwd?: unknown } }).process;
  const cwd = typeof proc?.cwd === 'function' ? (proc.cwd as () => string) : undefined;
  return { windows: proc?.platform === 'win32', cwd: () => (cwd ? cwd.call(proc) : undefined) };
}

export interface PathOps {
  isAbsolute(p: string): boolean;
  resolve(...segments: string[]): string;
  dirname(p: string): string;
  relative(from: string, to: string): string;
  /** The separator `resolve` and `relative` write for these paths: Node's `path.sep` on a Node host. */
  sepOf(...paths: string[]): '/' | '\\';
}

const DRIVE = /^[A-Za-z]:/;
const UNC = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/;
const winSep = (c: string | undefined): boolean => c === '/' || c === '\\';

/** A Windows path's root: its device (`C:`, `\\server\share`), whether it is absolute, and where the rest begins. */
function winRoot(p: string): { device: string; absolute: boolean; end: number; unc: boolean } {
  if (winSep(p[0])) {
    const unc = UNC.exec(p);
    return unc ? { device: `\\\\${unc[1]}\\${unc[2]}`, absolute: true, end: unc[0].length, unc: true }
      : { device: '', absolute: true, end: 1, unc: false };
  }
  if (DRIVE.test(p)) return { device: p.slice(0, 2), absolute: winSep(p[2]), end: winSep(p[2]) ? 3 : 2, unc: false };
  return { device: '', absolute: false, end: 0, unc: false };
}

/** The names of `tail` with `.` dropped and `..` applied; a `..` above the start is kept only when allowed. */
function normalize(tail: string, split: RegExp | string, allowAboveRoot: boolean): string[] {
  const out: string[] = [];
  for (const name of tail.split(split)) {
    if (!name || name === '.') continue;
    if (name !== '..') out.push(name);
    else if (out.length && out[out.length - 1] !== '..') out.pop();
    else if (allowAboveRoot) out.push('..');
  }
  return out;
}

function posixResolve(segments: string[], cwd: string | undefined): string {
  let tail = '';
  let absolute = false;
  for (let i = segments.length - 1; i >= -1 && !absolute; i--) {
    const p = i >= 0 ? segments[i]! : cwd ?? '/';
    if (!p) continue;
    tail = `${p}/${tail}`;
    absolute = p[0] === '/';
  }
  const names = normalize(tail, '/', !absolute).join('/');
  return absolute ? `/${names}` : names || '.';
}

function winResolve(segments: string[], host: PathHost): string {
  let device = '';
  let tail = '';
  let absolute = false;
  for (let i = segments.length - 1; i >= -1; i--) {
    let p: string;
    if (i >= 0) {
      p = segments[i]!;
      if (!p) continue;
    } else {
      // The working folder, or the device's root when it is on another device.
      const cwd = host.windows ? host.cwd() : undefined;
      if (cwd === undefined) break;
      p = !device || cwd.slice(0, 2).toLowerCase() === device.toLowerCase() ? cwd : `${device}\\`;
    }
    const root = winRoot(p);
    if (root.device) {
      if (!device) device = root.device;
      else if (root.device.toLowerCase() !== device.toLowerCase()) continue;
    }
    if (!absolute) {
      tail = `${p.slice(root.end)}\\${tail}`;
      absolute = root.absolute;
    }
    if (absolute && device) break;
  }
  const names = normalize(tail, /[\\/]/, !absolute).join('\\');
  return absolute ? `${device}\\${names}` : `${device}${names}` || '.';
}

function winDirname(p: string): string {
  if (!p) return '.';
  const root = winRoot(p);
  if (root.unc && root.end === p.length) return p;
  // A UNC root keeps the separator after the share.
  const rootEnd = root.end ? root.end + (root.unc ? 1 : 0) : -1;
  let end = -1;
  let matchedSlash = true;
  for (let i = p.length - 1; i >= Math.max(rootEnd, 0); i--) {
    if (!winSep(p[i])) matchedSlash = false;
    else if (!matchedSlash) {
      end = i;
      break;
    }
  }
  if (end !== -1) return p.slice(0, end);
  return rootEnd === -1 ? '.' : p.slice(0, rootEnd);
}

function posixDirname(p: string): string {
  if (!p) return '.';
  const hasRoot = p[0] === '/';
  let end = -1;
  let matchedSlash = true;
  for (let i = p.length - 1; i >= 1; i--) {
    if (p[i] !== '/') matchedSlash = false;
    else if (!matchedSlash) {
      end = i;
      break;
    }
  }
  if (end === -1) return hasRoot ? '/' : '.';
  return hasRoot && end === 1 ? '//' : p.slice(0, end);
}

/** The path operations for a host, read on every call (a test may change it). */
export function pathOps(host: () => PathHost): PathOps {
  const windows = (paths: string[]): boolean => host().windows || paths.some(p => DRIVE.test(p) || p[0] === '\\');
  const resolve = (...segments: string[]): string =>
    (windows(segments) ? winResolve(segments, host()) : posixResolve(segments, host().cwd()));
  return {
    isAbsolute: p => (windows([p]) ? winSep(p[0]) || (DRIVE.test(p) && winSep(p[2])) : p[0] === '/'),
    resolve,
    dirname: p => (windows([p]) ? winDirname(p) : posixDirname(p)),
    relative: (from, to) => {
      if (from === to) return '';
      const win = windows([from, to]);
      const f = resolve(from);
      const t = resolve(to);
      const fold = (s: string) => (win ? s.toLowerCase() : s);
      if (fold(f) === fold(t)) return '';
      // Names from the root down; on Windows the device (`c:`, or a UNC server and share) is the first of them.
      const names = (s: string) => s.split(win ? '\\' : '/').filter(Boolean);
      const fn = names(f);
      const tn = names(t);
      let common = 0;
      while (common < fn.length && common < tn.length && fold(fn[common]!) === fold(tn[common]!)) common++;
      // Nothing in common is another device: Node answers with the target itself.
      if (win && common === 0) return t;
      return [...fn.slice(common).map(() => '..'), ...tn.slice(common)].join(win ? '\\' : '/');
    },
    sepOf: (...paths) => (windows(paths) ? '\\' : '/'),
  };
}

export const { isAbsolute, resolve, dirname, relative, sepOf } = pathOps(() => hostOf(globalThis));
