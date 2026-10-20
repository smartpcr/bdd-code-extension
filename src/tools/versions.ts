// Lockstep versions (docs/packages, DEC-P03, D14): every runtime package
// carries the VS Code extension's version, which package.json holds. These
// functions read and write the version in each manifest and lock file by text,
// so a file's formatting survives a stamp; scripts/set-version.mjs and
// scripts/check-versions.mjs apply them to the repository.

/** How a file holds the version. */
export type VersionKind = 'csharp-props' | 'cargo-toml' | 'cargo-lock' | 'npm-package' | 'npm-lock' | 'psd1';

export interface VersionFile {
  /** Relative to the repository root, with forward slashes. */
  file: string;
  kind: VersionKind;
}

/** The runtimes' manifests, and every lock file that records a runtime this repository links by path. */
export const VERSION_FILES: readonly VersionFile[] = [
  { file: 'runtimes/csharp/Directory.Build.props', kind: 'csharp-props' },
  { file: 'runtimes/rust/Cargo.toml', kind: 'cargo-toml' },
  { file: 'runtimes/rust/Cargo.lock', kind: 'cargo-lock' },
  { file: 'samples/workspace/test/e2e/bindings/rust/Cargo.lock', kind: 'cargo-lock' },
  { file: 'samples/workspace/tests/rust/Cargo.lock', kind: 'cargo-lock' },
  { file: 'runtimes/typescript/package.json', kind: 'npm-package' },
  { file: 'runtimes/typescript/package-lock.json', kind: 'npm-lock' },
  { file: 'samples/workspace/test/e2e/bindings/typescript/package-lock.json', kind: 'npm-lock' },
  { file: 'samples/workspace/tests/typescript/package-lock.json', kind: 'npm-lock' },
  { file: 'runtimes/powershell/BddSuite/BddSuite.psd1', kind: 'psd1' },
];

/** The TypeScript runtime's package name, which the npm lock files record. */
export const NPM_RUNTIME = '@bdd-suite/runtime';
/** The Rust crate's name, which the Cargo lock files record. */
export const CRATE = 'suiterun';

/** x.y.z with an optional pre-release; what every registry accepts. */
export function isReleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}

interface Rule {
  read: (text: string) => string[];
  write: (text: string, version: string) => string;
}

/** A rule for a file whose versions a regular expression (not global) with groups (before, version, after) finds. */
function pattern(re: RegExp): Rule {
  const all = new RegExp(re.source, `${re.flags}g`);
  return {
    read: text => [...text.matchAll(all)].map(m => m[2]!),
    write: (text, version) => text.replace(all, (_, before: string, _old: string, after: string) => `${before}${version}${after}`),
  };
}

type Json = Record<string, unknown>;

/** npm lock files: the root when it is the runtime, and every package entry named after it. */
const npmLock: Rule = {
  read: text => {
    const lock = JSON.parse(text) as Json;
    const found: string[] = [];
    if (lock.name === NPM_RUNTIME) found.push(String(lock.version));
    for (const entry of Object.values((lock.packages ?? {}) as Record<string, Json>)) {
      if (entry.name === NPM_RUNTIME) found.push(String(entry.version));
    }
    return found;
  },
  write: (text, version) => {
    // Rewritten only when something changes, and with the file's own line ends.
    if (npmLock.read(text).every(v => v === version)) return text;
    const lock = JSON.parse(text) as Json;
    if (lock.name === NPM_RUNTIME) lock.version = version;
    for (const entry of Object.values((lock.packages ?? {}) as Record<string, Json>)) {
      if (entry.name === NPM_RUNTIME) entry.version = version;
    }
    const out = `${JSON.stringify(lock, null, 2)}\n`;
    return text.includes('\r\n') ? out.replace(/\n/g, '\r\n') : out;
  },
};

const RULES: Record<VersionKind, Rule> = {
  'csharp-props': pattern(/(<Version>)([^<]*)(<\/Version>)/),
  // The [package] table's own version, not a dependency's.
  'cargo-toml': pattern(/(^\[package\][^[]*?^version\s*=\s*")([^"]*)(")/m),
  // A path dependency's entry has no source line; the name and version lead it.
  'cargo-lock': pattern(new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${CRATE}"\\r?\\nversion = ")([^"]*)(")`)),
  // The first "version" of a package.json is the package's own, right under its name.
  'npm-package': pattern(/^(\{[^{]*?"version":\s*")([^"]*)(")/),
  'npm-lock': npmLock,
  'psd1': pattern(/(\bModuleVersion\s*=\s*')([^']*)(')/),
};

/** Every version a file of this kind holds. A runtime manifest holds one; a lock may hold several. */
export function versionsIn(kind: VersionKind, text: string): string[] {
  return RULES[kind].read(text);
}

/** The file with every version it holds set to this one. */
export function withVersion(kind: VersionKind, text: string, version: string): string {
  return RULES[kind].write(text, version);
}

/** What differs from the wanted version, one line per problem; empty when every file agrees. */
export function versionProblems(read: (file: string) => string | undefined, wanted: string,
  files: readonly VersionFile[] = VERSION_FILES): string[] {
  const problems: string[] = [];
  if (!isReleaseVersion(wanted)) problems.push(`package.json: "${wanted}" is not a version x.y.z`);
  for (const { file, kind } of files) {
    const text = read(file);
    if (text === undefined) {
      problems.push(`${file}: missing`);
      continue;
    }
    const found = versionsIn(kind, text);
    if (found.length === 0) problems.push(`${file}: holds no version`);
    for (const version of found.filter(v => v !== wanted)) problems.push(`${file}: ${version}, not ${wanted}`);
  }
  return problems;
}

/** Writes the wanted version into every file that holds another; returns the files it changed. */
export function stampVersions(read: (file: string) => string | undefined, write: (file: string, text: string) => void,
  wanted: string, files: readonly VersionFile[] = VERSION_FILES): string[] {
  if (!isReleaseVersion(wanted)) throw new Error(`"${wanted}" is not a version x.y.z`);
  const changed: string[] = [];
  for (const { file, kind } of files) {
    const text = read(file);
    if (text === undefined) throw new Error(`${file} is missing`);
    if (versionsIn(kind, text).length === 0) throw new Error(`${file} holds no version to set`);
    const next = withVersion(kind, text, wanted);
    if (next !== text) {
      write(file, next);
      changed.push(file);
    }
  }
  return changed;
}
