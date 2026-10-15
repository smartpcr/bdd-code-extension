// The ordered record of what a run did (Y3.3): one entry per step, hook step
// and case, in the order they happened. A report says which cases passed; a
// trace says in which order the phases ran, which steps a guard skipped and
// why each failure happened, which is what the conformance corpus compares.

export type Phase = 'suite-setup' | 'before-each' | 'case-setup' | 'step' | 'case-cleanup' | 'after-each' | 'suite-teardown' | 'case';
export type Status = 'passed' | 'failed' | 'skipped' | 'error';
export type Reason = 'assertion' | 'timeout' | 'action' | 'hook' | 'cleanup' | 'suite-setup' | 'tag' | 'guard' | '';

export interface Entry {
  phase: Phase;
  case?: string;
  step?: string;
  action?: string;
  status: Status;
  reason?: Exclude<Reason, ''>;
}

export class Trace {
  readonly entries: Entry[] = [];

  add(phase: Phase, caseName: string, step: string, action: string, status: Status, reason: Reason): void {
    this.entries.push({
      phase, ...(caseName ? { case: caseName } : {}), ...(step ? { step } : {}), ...(action ? { action } : {}), status,
      ...(reason ? { reason } : {}),
    });
  }

  /** The --trace-file document, in the key order of expectation.schema.json. */
  toJson(): string {
    return `${JSON.stringify(this.entries, null, 2)}\n`;
  }
}
