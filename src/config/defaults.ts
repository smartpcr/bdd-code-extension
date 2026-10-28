// Default settings (implementation plan 2.8). package.json's
// contributes.configuration is generated from these by scripts/sync-defaults.mjs,
// and a unit test fails when the two differ.

export interface Recognizer {
  pattern: string;
  flags?: string;
  /** Prepended to the captured name, for names a binding builds at run time. */
  prefix?: string;
}

export interface BuildCommand {
  command: string;
  cwd: string;
  shell?: boolean;
}

export interface BindingSettings {
  label: string;
  abbreviation: string;
  sources: string[];
  exclude: string[];
  recognizers: Recognizer[];
  /**
   * The binding's `suiterun`: argv before the verb. Every binding's program
   * takes the same verbs and flags (lint, actions, list, run).
   */
  tool: string[];
  build?: BuildCommand;
  library?: string;
  /** The program runs one case of a file by name (`--test-name`); otherwise a run covers whole files. */
  selectsOneCase?: boolean;
  /**
   * The program writes step events (`--events <file>`, spec/events.md) while it runs; a run
   * then marks each case as its `caseFinished` arrives, instead of at the end.
   */
  events?: boolean;
  /**
   * Where Declare action writes this binding's stub, relative to the root: the registry file
   * until the binding's own actions are somewhere (their file wins), and for PowerShell the
   * stub file, `${action}` being the action's PascalCase name.
   */
  stubFile?: string;
}

export interface Settings {
  catalogPath: string;
  root: string;
  suiteGlobs: string[];
  exclude: string;
  lintTool: string;
  targetBinding: string;
  bindings: Record<string, BindingSettings>;
  schemaGenerator: string[];
  'inlayHints.bindings': boolean;
  'codeLens.implement': boolean;
  templatesDir: string;
  'lab.apiUrl': string;
  'lab.labId': string;
  'lab.connectionFile': string;
  /** Which lab settings a lab run needs: only these are prompted for and shown in the confirmation. */
  'lab.required': string[];
  offlineActions: string[];
  contextKeys: string[];
}

/** The lab settings a workspace may list in `lab.required`. */
export const LAB_SETTING_KEYS = ['apiUrl', 'labId', 'connectionFile'] as const;

// DEC-S11: the layout a workspace built on the runtimes gets. A workspace's own
// actions are its extension of the runtimes, one project per language; each
// recognizer matches the registration idiom of that language's extension API,
// and its optional `handler` group names the handler for navigation.
export const DEFAULT_BINDINGS: Record<string, BindingSettings> = {
  powershell: {
    label: 'PowerShell',
    abbreviation: 'PS',
    sources: ['scripts/e2e/actions/*.ps1'],
    exclude: ['**/*.Tests.ps1'],
    recognizers: [
      // Register-LabAction is the runtime's alias of Register-SuiteAction.
      { pattern: "Register-(?:Suite|Lab)Action\\s+-Name\\s+'(?<name>[^'$]+)'" },
      { pattern: 'Register-(?:Suite|Lab)Action\\s+-Name\\s+"(?<name>[^"$]+)"' },
    ],
    tool: ['pwsh', '-NoProfile', '-NonInteractive', '-File', 'scripts/e2e/suiterun.ps1'],
    selectsOneCase: true,
  },
  csharp: {
    label: 'C#',
    abbreviation: 'C#',
    sources: ['test/e2e/bindings/dotnet/**/*.cs'],
    exclude: ['**/{artifacts,bin,obj}/**'],
    recognizers: [
      { pattern: 'new ActionRegistration\\(\\s*"(?<name>[^"]+)"(?:\\s*,\\s*(?<handler>[\\w.]+)\\s*\\))?' },
      // A dictionary registry, as the runtime's CoreActions keeps one: `["ns.name"] = Handler,` on a
      // line of its own. A dotted name and a method-group value keep data dictionaries out.
      { pattern: '^[ \\t]*\\["(?<name>[\\w-]+(?:\\.[\\w-]+)+)"\\][ \\t]*=[ \\t]*(?<handler>(?!(?:true|false|null)\\b)[A-Za-z_][\\w.]*)[ \\t]*,[ \\t]*\\r?$' },
    ],
    tool: ['test/e2e/bindings/dotnet/artifacts/bin/Suite.Cli/Debug/net10.0/suiterun.exe'],
    build: { command: 'dotnet build', cwd: 'test/e2e/bindings/dotnet' },
  },
  go: {
    label: 'Go',
    abbreviation: 'Go',
    sources: ['test/e2e/bindings/go/**/*.go'],
    exclude: ['**/*_test.go'],
    recognizers: [
      { pattern: '\\{\\s*Name:\\s*"(?<name>[^"]+)",\\s*Handler:(?:\\s*(?<handler>[\\w.]+)\\s*[,}])?' },
    ],
    tool: ['${storage}/go/suiterun.exe'],
    build: { command: 'go build -o ${storage}/go/suiterun.exe ./cmd/suiterun', cwd: 'test/e2e/bindings/go' },
  },
  rust: {
    label: 'Rust',
    abbreviation: 'Rs',
    sources: ['test/e2e/bindings/rust/src/**/*.rs'],
    exclude: [],
    recognizers: [
      { pattern: 'Action::new\\(\\s*"(?<name>[^"]+)"(?:\\s*,\\s*(?<handler>[\\w:]+)\\s*\\))?' },
    ],
    tool: ['test/e2e/bindings/rust/target/debug/suiterun.exe'],
    build: { command: 'cargo build', cwd: 'test/e2e/bindings/rust' },
  },
  typescript: {
    label: 'TypeScript',
    abbreviation: 'TS',
    sources: ['test/e2e/bindings/typescript/src/**/*.ts'],
    exclude: ['**/*.test.ts'],
    recognizers: [
      { pattern: "\\baction\\(\\s*'(?<name>[^']+)'(?:\\s*,\\s*(?<handler>[\\w.]+)\\s*\\))?" },
    ],
    tool: ['node', 'test/e2e/bindings/typescript/dist/cli.js'],
    build: { command: 'npm ci && npm run build', cwd: 'test/e2e/bindings/typescript', shell: true },
    library: 'test/e2e/bindings/typescript/dist/index.js',
  },
};

export const DEFAULT_SETTINGS: Settings = {
  catalogPath: 'test/e2e/schema/actions.catalog.yaml',
  // Empty: found from the catalog (WorkspaceLayout.create).
  root: '',
  suiteGlobs: ['test/e2e/**/*.yml'],
  exclude: '**/{node_modules,bin,obj,target,artifacts,.git}/**',
  // B8.3: the in-editor TypeScript lint met O10 (p95 429 ms on os-context's largest suite), so it is the default (DEC-B04).
  lintTool: 'typescript',
  targetBinding: 'powershell',
  bindings: DEFAULT_BINDINGS,
  // The generator the extension carries (docs/packages, D12): a workspace needs no copy of the spec.
  schemaGenerator: ['pwsh', '-NoProfile', '-NonInteractive', '-File', '${extension}/spec/Build-Schema.ps1', '-Catalog', '${catalogPath}'],
  'inlayHints.bindings': true,
  'codeLens.implement': true,
  templatesDir: '',
  'lab.apiUrl': '',
  'lab.labId': '',
  'lab.connectionFile': '',
  // Every lab setting, as before this setting existed; a workspace whose program needs only one lists only that one.
  'lab.required': [...LAB_SETTING_KEYS],
  // B6.4 item 1: by default only the built-in core actions and wait run without a lab.
  offlineActions: ['core.*', 'wait'],
  // Only the runtimes' extensions know their context keys; the workspace names them once for completion.
  contextKeys: [],
};

/** The description each setting carries in package.json. */
export const SETTING_DESCRIPTIONS: Record<keyof Settings, string> = {
  catalogPath: 'The action catalog, relative to the workspace folder. Its folder holds suite.schema.json and is the schema root every binding program reads.',
  root: 'The suites\' root, relative to the workspace folder: binding programs run in it, and each binding\'s `tool`, `build.cwd`, `library` and `stubFile` are relative to it. Empty: the nearest folder above the catalog holding test/e2e/schema, else the folder above the catalog\'s folder.',
  suiteGlobs: 'Candidate suite files; a file is a suite when it has a top-level `suite:` key or is imported by one.',
  exclude: 'Glob of files never indexed.',
  lintTool: 'The binding whose code lints suites.',
  targetBinding: 'The binding suites are meant to run with; lint reports actions it does not implement (E201).',
  bindings: 'Per binding: source globs (the catalog\'s `bindingSources`, when it has them, win), registration recognizers, program (its `suiterun`, which every binding calls with the same verbs and flags), build command, `selectsOneCase` when the program runs one case by name, `events` when it writes step events (`--events`), so a run marks each case as it finishes, and `stubFile`, where Declare action writes a stub (PowerShell: `${action}` is the action\'s PascalCase name).',
  schemaGenerator: 'Command that regenerates suite.schema.json after a catalog edit, run in the workspace root. `${extension}` is the extension\'s folder (the default runs the spec\'s Build-Schema.ps1 it carries) and `${catalogPath}` the catalog.',
  'inlayHints.bindings': 'Show which bindings implement each step\'s action.',
  'codeLens.implement': 'Above a step whose action is missing in a language, offer to declare or implement it.',
  templatesDir: 'Workspace directory whose files override the stub templates; its `skeleton/<part>/` files (`common`, `csharp`, `powershell`, `go`, `rust`, `typescript`) override those of *Create suites workspace skeleton*, file by file.',
  'lab.apiUrl': 'The API URL of the environment (lab) a lab run targets; prompted when empty.',
  'lab.labId': 'The id of the environment (lab) a lab run targets; prompted when empty.',
  'lab.connectionFile': 'The connection file of the environment (lab) a lab run targets; prompted when empty.',
  'lab.required': 'Which lab settings a lab run needs (apiUrl, labId, connectionFile): only these are prompted for when empty and shown in the confirmation; the others are passed to the program when set.',
  offlineActions: 'Actions that run without a lab, as names or `prefix.*`; a suite using any other action is a lab suite, and its run asks for the lab and a confirmation.',
  contextKeys: 'Context keys the workspace\'s runtime extensions add (each read as ${key}), offered by completion beside the core\'s `timeoutSec` and `defaults`.',
};
