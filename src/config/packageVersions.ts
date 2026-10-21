// The bdd-suite package versions a workspace pins (docs/packages, D12, DEC-P07):
// the extension's bundled core and schema generator are those of its own
// version, and every package of a release carries that version (DEC-P03), so a
// workspace that pins another release is told. Read from the manifests at the
// workspace's top only, by text. No vscode import, so it is unit-tested in Node.
import * as path from 'path';

export interface PinnedVersion {
  /** The manifest, as found. */
  file: string;
  /** The bdd-suite package it pins. */
  package: string;
  version: string;
}

const VERSION = '(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)';

interface Rule {
  /** The manifest's name, or a test of it. */
  name: string | ((file: string) => boolean);
  package: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  // Central package management: the property the C# consumer sample pins with, or a PackageVersion item.
  { name: 'Directory.Packages.props', package: 'Bdd.Suite', pattern: new RegExp(`<BddSuiteVersion\\b[^>]*>\\s*${VERSION}\\s*<`) },
  // nuget.org reserves Bdd.Suite, so the packages are Smartpcr.BddSuite* from 0.7.4; GitHub Packages had Bdd.Suite* before.
  { name: 'Directory.Packages.props', package: 'Smartpcr.BddSuite', pattern: new RegExp(`<PackageVersion\\s+Include="Smartpcr\\.BddSuite(?:\\.Testing)?"\\s+Version="${VERSION}"`) },
  { name: 'Directory.Packages.props', package: 'Bdd.Suite', pattern: new RegExp(`<PackageVersion\\s+Include="Bdd\\.Suite(?:\\.Testing)?"\\s+Version="${VERSION}"`) },
  { name: 'go.mod', package: 'github.com/smartpcr/bdd-code-extension/runtimes/go', pattern: new RegExp(`github\\.com/smartpcr/bdd-code-extension/runtimes/go v${VERSION}`) },
  { name: 'Cargo.toml', package: 'suiterun', pattern: new RegExp(`^suiterun\\s*=\\s*(?:"|\\{[^}\\n]*\\bversion\\s*=\\s*")[=^~]?${VERSION}"`, 'm') },
  { name: 'package.json', package: '@bdd-suite/runtime', pattern: new RegExp(`"@bdd-suite/runtime"\\s*:\\s*"[=^~]?${VERSION}"`) },
  // A module manifest's RequiredModules, or a script's #Requires.
  { name: f => /\.ps(d?)1$/i.test(f), package: 'BddSuite', pattern: new RegExp(`ModuleName\\s*=\\s*'BddSuite'\\s*;\\s*(?:Required|Module)Version\\s*=\\s*'${VERSION}'`) },
];

/**
 * Every bdd-suite version the manifests directly in `folders` pin, each
 * folder once. `list` names a folder's files (none when it cannot be read),
 * `read` a file's text (undefined when it cannot).
 */
export function pinnedVersions(folders: readonly string[], list: (folder: string) => string[], read: (file: string) => string | undefined): PinnedVersion[] {
  const found: PinnedVersion[] = [];
  for (const folder of [...new Set(folders)]) {
    for (const name of list(folder).sort()) {
      const rules = RULES.filter(r => (typeof r.name === 'string' ? r.name === name : r.name(name)));
      if (!rules.length) continue;
      const file = path.join(folder, name);
      const text = read(file);
      if (text === undefined) continue;
      for (const rule of rules) {
        const m = rule.pattern.exec(text);
        if (m) found.push({ file, package: rule.package, version: m[1]! });
      }
    }
  }
  return found;
}

/** The warning when any pin differs from the extension's own version; undefined when none does. */
export function versionWarning(own: string, pins: readonly PinnedVersion[]): string | undefined {
  const other = pins.filter(p => p.version !== own);
  if (!other.length) return undefined;
  const named = other.map(p => `${path.basename(p.file)}: ${p.package} ${p.version}`).join('; ');
  return `This workspace pins bdd-suite packages at another release than Suite Authoring ${own} (${named}). `
    + `The extension's bundled core, schema generator and linter are ${own}'s; install the extension of the same release, or move the packages to ${own}.`;
}
