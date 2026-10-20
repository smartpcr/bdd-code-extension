// The live lines `run --progress` prints while a run is going (spec/progress.md).
//
// A run of many lab suites takes hours, and the people and tools watching it
// need to know which case is running and how the finished ones went before the
// report is written at the end. The lines use the shape TAEF's console output
// has, because existing lab tooling already parses it:
//
//       suite-setup   step 1 (core.record) passed
//   StartGroup: orders::place-an-order
//       step          when the order is placed (shop.order) passed
//   EndGroup: orders::place-an-order [Passed] (3s)
//   Summary: Total=1, Passed=1, Failed=0, Blocked=0, Not Run=0, Skipped=0
//
// Only selected cases are counted: a case the tag or name filter left out was
// never part of this run.

import type { CaseResult, RunObserver } from './exec.js';
import type { Entry } from './trace.js';

/** Where the lines go: standard output unless a test points them elsewhere. */
let writeLine: (line: string) => void = line => process.stdout.write(`${line}\n`);

/** Points the progress lines at `write`, standard output when it is undefined, and hands back what was set before. */
export function setProgressWriter(write?: (line: string) => void): (line: string) => void {
  const before = writeLine;
  writeLine = write ?? (line => process.stdout.write(`${line}\n`));
  return before;
}

/** The observer behind run --progress. */
export class ProgressPrinter implements RunObserver {
  private passed = 0;
  private failed = 0;
  private skipped = 0;

  caseStarted(suite: string, caseName: string): void {
    writeLine(`StartGroup: ${suite}::${caseName}`);
  }

  caseFinished(suite: string, result: CaseResult): void {
    const verdict = result.status === 'passed' ? 'Passed' : result.status === 'skipped' ? 'Skipped' : 'Failed';
    if (verdict === 'Passed') this.passed++;
    else if (verdict === 'Skipped') this.skipped++;
    else this.failed++;
    if (verdict === 'Failed' && result.message) writeLine(`    failure: ${result.message.replace(/\r\n|\r|\n/g, ' ')}`);
    // Rounded half away from zero, as the other runtimes round (durations are not negative).
    writeLine(`EndGroup: ${suite}::${result.name} [${verdict}] (${Math.round(result.durationSec)}s)`);
  }

  /** One line per trace entry other than a case's result, so the last line of a log says what a long case is doing. */
  entry(entry: Entry): void {
    if (entry.phase === 'case') return;
    const step = entry.step ?? '';
    // A step label written with a Gherkin keyword already ends in "(action)".
    const action = entry.action && !step.includes(`(${entry.action})`) ? ` (${entry.action})` : '';
    const reason = entry.reason ? ` [${entry.reason}]` : '';
    writeLine(`    ${entry.phase.padEnd(13)} ${step}${action} ${entry.status}${reason}`);
  }

  /** The closing line, which the tooling reads as authoritative. */
  summary(): void {
    const total = this.passed + this.failed + this.skipped;
    writeLine(`Summary: Total=${total}, Passed=${this.passed}, Failed=${this.failed}, Blocked=0, Not Run=0, Skipped=${this.skipped}`);
  }
}
