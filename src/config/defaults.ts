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
  kind: 'suiterun' | 'powershell';
  sources: string[];
  exclude: string[];
  recognizers: Recognizer[];
  tool: string[];
  build?: BuildCommand;
  library?: string;
}

export interface Settings {
  catalogPath: string;
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
  offlineActions: string[];
}

export const DEFAULT_BINDINGS: Record<string, BindingSettings> = {
  powershell: {
    label: 'PowerShell',
    abbreviation: 'PS',
    kind: 'powershell',
    sources: ['scripts/e2e/actions/*.ps1'],
    exclude: ['**/*.Tests.ps1'],
    recognizers: [
      { pattern: "Register-LabAction\\s+-Name\\s+'(?<name>[^'$]+)'" },
      { pattern: 'Register-LabAction\\s+-Name\\s+"(?<name>[^"$]+)"' },
      // lab-lifecycle.ps1 registers five lifecycle actions in a loop over a table of these entries.
      { pattern: "@\\{\\s*name\\s*=\\s*'(?<name>[^']+)';\\s*verb\\s*=\\s*'lifecycle\\.", prefix: 'lifecycle.' },
    ],
    tool: ['pwsh', '-NoProfile', '-NonInteractive'],
  },
  csharp: {
    label: 'C#',
    abbreviation: 'C#',
    kind: 'suiterun',
    sources: ['test/e2e/bindings/dotnet/Hci.E2E.Suite/**/*.cs'],
    exclude: [],
    recognizers: [
      { pattern: '^\\s*\\[\\s*"(?<name>[a-z]\\w*(?:\\.\\w+)+)"\\s*\\]\\s*=\\s*(?<handler>.+?),?\\s*$' },
      { pattern: 'names\\.Add\\("(?<name>[^"]+)"\\)' },
    ],
    tool: ['test/e2e/bindings/dotnet/artifacts/bin/Hci.E2E.Suite.Cli/Debug/net10.0/suiterun.exe'],
    build: { command: 'dotnet build', cwd: 'test/e2e/bindings/dotnet' },
  },
  go: {
    label: 'Go',
    abbreviation: 'Go',
    kind: 'suiterun',
    sources: ['test/e2e/bindings/go/internal/**/*.go'],
    exclude: ['**/*_test.go'],
    recognizers: [
      { pattern: '^\\s*"(?<name>[a-z][\\w]*(?:\\.[\\w]+)+)"\\s*:\\s*(?<handler>[\\w.]+)' },
      { pattern: 'append\\(names,\\s*"(?<name>[\\w.]+)"\\)' },
    ],
    tool: ['${storage}/go/suiterun.exe'],
    build: { command: 'go build -o ${storage}/go/suiterun.exe ./cmd/suiterun', cwd: 'test/e2e/bindings/go' },
  },
  rust: {
    label: 'Rust',
    abbreviation: 'Rs',
    kind: 'suiterun',
    sources: ['test/e2e/bindings/rust/src/**/*.rs'],
    exclude: [],
    recognizers: [
      { pattern: 'map\\.insert\\(\\s*"(?<name>[a-z]\\w*(?:\\.\\w+)+)"\\s*,\\s*(?<handler>\\w+)\\s*\\)' },
      { pattern: '^\\s*"(?<name>[a-z]\\w*(?:\\.\\w+)+)"\\s*=>\\s*(?<handler>\\w+)\\(' },
      { pattern: 'names\\.push\\("(?<name>[^"]+)"\\.to_string\\(\\)\\)' },
    ],
    tool: ['test/e2e/bindings/rust/target/debug/suiterun.exe'],
    build: { command: 'cargo build', cwd: 'test/e2e/bindings/rust' },
  },
  typescript: {
    label: 'TypeScript',
    abbreviation: 'TS',
    kind: 'suiterun',
    sources: ['test/e2e/bindings/typescript/src/**/*.ts'],
    exclude: ['**/*.test.ts'],
    recognizers: [
      { pattern: "\\baction\\(\\s*'(?<name>[^']+)'\\s*,\\s*(?<handler>[\\w.]+)\\s*\\)" },
    ],
    tool: ['node', 'test/e2e/bindings/typescript/dist/cli.js'],
    build: { command: 'npm ci && npm run build', cwd: 'test/e2e/bindings/typescript', shell: true },
    library: 'test/e2e/bindings/typescript/dist/index.js',
  },
};

export const DEFAULT_SETTINGS: Settings = {
  catalogPath: 'test/e2e/schema/actions.catalog.yaml',
  suiteGlobs: ['test/e2e/**/*.yml'],
  exclude: '**/{node_modules,bin,obj,target,artifacts,.git}/**',
  // B8.3: the in-editor TypeScript lint met O10 (p95 429 ms on lifecycle-stage1.yml), so it is the default (DEC-B04).
  lintTool: 'typescript',
  targetBinding: 'powershell',
  bindings: DEFAULT_BINDINGS,
  schemaGenerator: ['pwsh', '-NoProfile', '-NonInteractive', '-File', 'test/e2e/schema/Build-Schema.ps1'],
  'inlayHints.bindings': true,
  'codeLens.implement': true,
  templatesDir: '',
  'lab.apiUrl': '',
  'lab.labId': '',
  'lab.connectionFile': '',
  // B6.4 item 1: by default only the built-in core actions and wait run without a lab.
  offlineActions: ['core.*', 'wait'],
};

/** The description each setting carries in package.json. */
export const SETTING_DESCRIPTIONS: Record<keyof Settings, string> = {
  catalogPath: 'The action catalog, relative to the workspace folder.',
  suiteGlobs: 'Candidate suite files; a file is a suite when it has a top-level `suite:` key or is imported by one.',
  exclude: 'Glob of files never indexed.',
  lintTool: 'The binding whose code lints suites.',
  targetBinding: 'The binding suites are meant to run with; lint reports actions it does not implement (E201).',
  bindings: 'Per binding: source globs, registration recognizers, program and build command.',
  schemaGenerator: 'Command that regenerates suite.schema.json after a catalog edit.',
  'inlayHints.bindings': 'Show which bindings implement each step\'s action.',
  'codeLens.implement': 'Above a step whose action is missing in a language, offer to declare or implement it.',
  templatesDir: 'Workspace directory whose files override the stub templates.',
  'lab.apiUrl': 'The API URL of the environment (lab) a lab run targets; prompted when empty.',
  'lab.labId': 'The id of the environment (lab) a lab run targets; prompted when empty.',
  'lab.connectionFile': 'The connection file of the environment (lab) a lab run targets; prompted when empty.',
  offlineActions: 'Actions that run without a lab, as names or `prefix.*`; a suite using any other action is a lab suite, and its run asks for the lab and a confirmation.',
};
