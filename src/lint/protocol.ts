// The messages between the extension and the lint worker (plan 2.4b). Types
// only, so the worker bundle and the host share no code beyond them.

/** What `createLinter().lint()` takes (the binding's LintRequest, DEC-B20). */
export interface LibraryLintRequest {
  paths: string[];
  binding: string;
  bindingCheck: boolean;
  strict: boolean;
  overlays: Record<string, string>;
}

export type HostMessage =
  | { type: 'lint'; id: number; root: string; request: LibraryLintRequest }
  | { type: 'invalidate'; root: string };

export type WorkerMessage =
  | { type: 'ready'; apiVersion: string }
  | { type: 'refused'; reason: 'load' | 'api'; detail: string; apiVersion?: string }
  | { type: 'result'; id: number; diagnostics: unknown[] }
  | { type: 'error'; id: number; detail: string };
