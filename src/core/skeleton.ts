// A new suites workspace from templates (*Suite: Create suites workspace
// skeleton*): settings, catalog, a first suite and one binding per language
// (C#, PowerShell, Go, Rust, TypeScript),
// laid out as samples/e2e is. Pure: the caller reads the templates (the shipped
// templates/skeleton/<part>/ under any bddSuite.templatesDir/skeleton/<part>/)
// and writes the files.
import { camelName, pascalName, snakeName } from './stubs';

/** The languages a skeleton has a binding template for. */
export type SkeletonLanguage = 'csharp' | 'powershell' | 'go' | 'rust' | 'typescript';

/** What a language adds to the shared files: the catalog, the settings and the recommendations. */
interface LanguageSkeleton {
  label: string;
  description: string;
  /** The catalog's bindingSources glob, relative to schema/. */
  bindingSources: (ns: string) => string;
  /** Its bddSuite.bindings entry. */
  settings: (ns: string) => Record<string, unknown>;
  /** The editor extension for the language, when VS Code has none built in. */
  recommendation?: string;
}

const LANGUAGES: Record<SkeletonLanguage, LanguageSkeleton> = {
  csharp: {
    label: 'C#',
    description: 'Smartpcr.BddSuite packages, suiterun and MSTest tests generated at build',
    bindingSources: ns => `../bindings/dotnet/${ns}.Suite/**/*.cs`,
    settings: ns => ({
      tool: [`bindings/dotnet/artifacts/bin/${ns}.Suite.Cli/Debug/net10.0/suiterun.exe`],
      build: { command: `dotnet build bindings/dotnet/${ns}.Suite.Cli/${ns}.Suite.Cli.csproj -c Debug`, cwd: '.' },
    }),
    recommendation: 'ms-dotnettools.csharp',
  },
  powershell: {
    label: 'PowerShell',
    description: 'the BddSuite module (packages.psd1), suiterun.ps1 and generated Pester tests',
    bindingSources: ns => `../bindings/powershell/${ns}/actions/*.ps1`,
    settings: ns => ({
      tool: ['pwsh', '-NoProfile', '-NonInteractive', '-File', 'bindings/powershell/suiterun.ps1'],
      stubFile: `bindings/powershell/${ns}/actions/\${action}.ps1`,
    }),
    recommendation: 'ms-vscode.powershell',
  },
  // Go, Rust and TypeScript keep their registrations in one registry file, the stubFile Declare action
  // extends (core/stubs.ts: goPlan, rustPlan, typescriptPlan).
  go: {
    label: 'Go',
    description: 'the bdd-suite Go module (go.mod), cmd/suiterun and go test tests from go generate',
    bindingSources: () => '../bindings/go/actions/*.go',
    settings: () => ({
      tool: ['bindings/go/bin/suiterun.exe'],
      build: { command: 'go mod tidy && go build -o bin/suiterun.exe ./cmd/suiterun', cwd: 'bindings/go', shell: true },
      stubFile: 'bindings/go/actions/actions.go',
    }),
    recommendation: 'golang.go',
  },
  rust: {
    label: 'Rust',
    description: 'the suiterun crate (Cargo.toml), a suiterun binary and cargo test tests listed by build.rs',
    bindingSources: () => '../bindings/rust/src/**/*.rs',
    settings: () => ({
      tool: ['bindings/rust/target/debug/suiterun.exe'],
      build: { command: 'cargo build', cwd: 'bindings/rust' },
      stubFile: 'bindings/rust/src/actions.rs',
    }),
    recommendation: 'rust-lang.rust-analyzer',
  },
  typescript: {
    label: 'TypeScript',
    description: 'the @bdd-suite/runtime package (package.json), a suiterun and node:test tests',
    bindingSources: () => '../bindings/typescript/src/**/*.ts',
    settings: () => ({
      tool: ['node', 'bindings/typescript/dist/cli.js'],
      build: { command: 'npm install && npm run build', cwd: 'bindings/typescript', shell: true },
      library: 'bindings/typescript/dist/index.js',
      stubFile: 'bindings/typescript/src/actions.ts',
    }),
  },
};

/** The languages in the order a picker shows them. */
export const SKELETON_LANGUAGES: { id: SkeletonLanguage; label: string; description: string }[] =
  (Object.keys(LANGUAGES) as SkeletonLanguage[]).map(id => ({ id, label: LANGUAGES[id].label, description: LANGUAGES[id].description }));

export const isSkeletonLanguage = (s: string): s is SkeletonLanguage => Object.prototype.hasOwnProperty.call(LANGUAGES, s);

/** What one name gives a skeleton: `order-service` is the suite and folder name, `OrderService` the namespace, `orderService` the actions' family. */
export interface SkeletonNames {
  name: string;
  namespace: string;
  prefix: string;
  /** The first action, `<prefix>.echo`. */
  action: string;
  /** Its PascalCase name: the C# handler and the PowerShell file. */
  actionName: string;
  /** Its camelCase name: the Go and TypeScript handler. */
  actionCamel: string;
  /** Its snake_case name: the Rust handler. */
  actionSnake: string;
  /** The Rust library crate: the name with `_` for `-`. */
  crate: string;
}

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Why a skeleton name is refused, or undefined when it is one. */
export function skeletonNameProblem(name: string): string | undefined {
  return NAME.test(name) ? undefined : 'A name is lower-case letters and digits in words joined by "-", starting with a letter (order-service).';
}

/** The names a valid skeleton name gives (skeletonNameProblem first). */
export function skeletonNames(name: string): SkeletonNames {
  const words = name.split('-');
  const namespace = words.map(w => w[0].toUpperCase() + w.slice(1)).join('');
  const prefix = namespace[0].toLowerCase() + namespace.slice(1);
  const action = `${prefix}.echo`;
  return {
    name, namespace, prefix, action,
    actionName: pascalName(action), actionCamel: camelName(action), actionSnake: snakeName(action), crate: words.join('_'),
  };
}

/** A name for a skeleton from a folder's name: `My Orders_v2` is `my-orders-v2`; undefined when nothing usable is left. */
export function suggestSkeletonName(folderName: string): string | undefined {
  const words = folderName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  while (words.length && !/^[a-z]/.test(words[0])) words.shift();
  return words.length ? words.join('-') : undefined;
}

/** One file, by its path relative to its part (or, planned, to the target folder), with `/` separators. */
export interface TemplateFile {
  path: string;
  text: string;
}

/**
 * Folders a template tree never holds: what a build of the templates in place
 * leaves (an editor's C#, Rust or TypeScript tooling may build them), skipped
 * when the templates are read.
 */
export const BUILD_OUTPUT_DIRS: ReadonlySet<string> = new Set(['artifacts', 'bin', 'obj', 'target', 'node_modules', 'dist', '.vs']);

/** `own` (bddSuite.templatesDir) over `shipped`: a file of the same path replaces the shipped one; a new one is added. */
export function overlayTemplates(shipped: readonly TemplateFile[], own: readonly TemplateFile[]): TemplateFile[] {
  const byPath = new Map(shipped.map(f => [f.path, f] as const));
  for (const f of own) byPath.set(f.path, f);
  return [...byPath.values()];
}

export interface SkeletonInput {
  name: string;
  /** In the order chosen: the first is the target binding and the lint tool. */
  languages: readonly SkeletonLanguage[];
  /** The bdd-suite release the packages are pinned to: the extension's own. */
  version: string;
  /** The templates of a part: `common`, then each language. */
  templates: (part: string) => readonly TemplateFile[];
}

export interface SkeletonPlan {
  names: SkeletonNames;
  files: TemplateFile[];
}

/** The parts every skeleton is made of: the shared files, then one per language. */
export const skeletonParts = (languages: readonly SkeletonLanguage[]): string[] => ['common', ...languages];

const indentAfterFirst = (text: string, by: string) => text.split('\n').join(`\n${by}`);

/** The values a template's `{{key}}` takes. */
function skeletonVars(names: SkeletonNames, languages: readonly SkeletonLanguage[], version: string): Record<string, string> {
  const ns = names.namespace;
  const bindings: Record<string, unknown> = {};
  for (const l of languages) bindings[l] = LANGUAGES[l].settings(ns);
  const offline = ['core.*', 'wait', names.action];
  return {
    name: names.name,
    Namespace: ns,
    prefix: names.prefix,
    action: names.action,
    ActionName: names.actionName,
    actionCamel: names.actionCamel,
    actionSnake: names.actionSnake,
    crate: names.crate,
    version,
    languages: languages.map(l => LANGUAGES[l].label).join(' and '),
    lintTool: languages[0],
    targetBinding: languages[0],
    bindings: `[${languages.join(', ')}]`,
    bindingSources: languages.map(l => `  ${l}: [${LANGUAGES[l].bindingSources(ns)}]`).join('\n'),
    offlineActions: `[${offline.map(a => JSON.stringify(a)).join(', ')}]`,
    bindingsJson: indentAfterFirst(JSON.stringify(bindings, null, 2), '  '),
    recommendations: JSON.stringify(['asz.bdd-suite', ...languages.flatMap(l => LANGUAGES[l].recommendation ?? [])]),
  };
}

const fill = (text: string, vars: Record<string, string>) =>
  text.replace(/\{\{(\w+)\}\}/g, (all, key: string) => (Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : all));

/** A template path as written: `__key__` takes the key's value, and a `dot.` segment is a dot-file (`dot.vscode` is `.vscode`). */
function targetPath(templatePath: string, vars: Record<string, string>): string {
  return templatePath.split('/').map(segment => {
    const named = segment.replace(/__(\w+)__/g, (all, key: string) => (Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : all));
    return named.startsWith('dot.') ? `.${named.slice(4)}` : named;
  }).join('/');
}

/**
 * The files of a new workspace: each part's templates, filled in. Two parts
 * writing one path (README.md, .gitignore) are joined, the common part first,
 * so a language adds its section.
 */
export function planSkeleton(input: SkeletonInput): SkeletonPlan | { refused: string } {
  const problem = skeletonNameProblem(input.name);
  if (problem) return { refused: problem };
  if (!input.languages.length) return { refused: 'Choose at least one language for the binding.' };
  if (new Set(input.languages).size !== input.languages.length) return { refused: 'A language is listed twice.' };
  // The name's rule makes `<prefix>.echo` an action name the catalog can hold (ACTION_NAME).
  const names = skeletonNames(input.name);
  const vars = skeletonVars(names, input.languages, input.version);
  const files = new Map<string, string>();
  for (const part of skeletonParts(input.languages)) {
    const templates = input.templates(part);
    if (!templates.length) return { refused: `There are no templates for ${part}.` };
    for (const t of [...templates].sort((a, b) => a.path.localeCompare(b.path))) {
      const at = targetPath(t.path, vars);
      const text = fill(t.text, vars);
      const before = files.get(at);
      files.set(at, before === undefined ? text : `${before.replace(/\n*$/, '\n')}\n${text}`);
    }
  }
  return { names, files: [...files].map(([path, text]) => ({ path, text })) };
}
