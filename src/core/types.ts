// Data types shared by the pure core (implementation plan 2.3). Positions are
// zero-based, as in VS Code.
import { Range } from './text';

export type { Pos, Range } from './text';
export type BindingName = string;

/** A finding the extension itself makes; codes BDD001-BDD099, never E/W (INV-2). */
export interface CoreError {
  code: string;
  message: string;
  range: Range;
}

export interface CaptureShape {
  type?: string;
  open: boolean;
  properties: Map<string, CaptureShape>;
  items?: CaptureShape;
}

export interface CatalogParam {
  name: string;
  type?: string;
  required?: boolean;
  default?: unknown;
  description?: string;
  range: Range;
}

export interface CatalogAction {
  name: string;
  nameRange: Range;
  entryRange: Range;
  summary: string;
  notes?: string;
  deprecated?: boolean;
  bindings: BindingName[];
  bindingsRange?: Range;
  interruptible: boolean;
  params: CatalogParam[];
  captures: CaptureShape;
}

export interface Catalog {
  file: string;
  bindings: BindingName[];
  actions: Map<string, CatalogAction>;
  errors: CoreError[];
}

export type HookName = 'setup' | 'teardown' | 'beforeEach' | 'afterEach' | 'cleanup';

export type StepHome =
  | { kind: 'case'; caseName: string; caseIndex: number }
  /** caseName is set for a case's own setup and cleanup. */
  | { kind: 'hook'; hook: HookName; caseName?: string }
  | { kind: 'meta'; metaName: string };

export type Keyword = 'given' | 'when' | 'then' | 'and';

export interface Named {
  name: string;
  range: Range;
}

export interface StepInfo {
  file: string;
  range: Range;
  /** Position in the file's document order. */
  index: number;
  home: StepHome;
  keyword?: Keyword;
  sentence?: string;
  action?: string;
  actionRange?: Range;
  meta?: string;
  metaRange?: Range;
  withKeys: Named[];
  captureAs?: string;
  captureAsRange?: Range;
  params: (Named & { value: unknown })[];
  tableColumns?: string[];
  /** Each ${...}, with the range of its `$` through its `}`. */
  expressions: { text: string; range: Range }[];
}

export interface MetaStepDef {
  name: string;
  range: Range;
  nameRange: Range;
  params: string[];
  exports: string[];
}

export interface CaseInfo {
  name: string;
  range: Range;
  tags: string[];
  examplesColumns?: string[];
  examplesRows: number;
  params: string[];
}

export interface ImportRef {
  path: string;
  resolved: string;
  range: Range;
}

export interface SuiteFile {
  file: string;
  /** True when the root mapping has a `suite:` key. */
  hasSuiteKey: boolean;
  /** The document parsed but its root is not a mapping (lint reports E100). */
  notAMapping?: boolean;
  suiteName?: string;
  imports: ImportRef[];
  params: Named[];
  vars: (Named & { caseName?: string })[];
  metaSteps: MetaStepDef[];
  cases: CaseInfo[];
  steps: StepInfo[];
  parseError?: CoreError;
}

export interface RegistrationSite {
  binding: BindingName;
  action: string;
  handler?: string;
  file: string;
  range: Range;
  recognizer: number;
}
