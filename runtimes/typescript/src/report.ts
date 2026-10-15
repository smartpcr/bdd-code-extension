// The two report formats CI publishes (DEC-Y15): NUnit 3 by default, and
// JUnit. Written by hand: the documents are small and fixed, and a library
// would decide attribute order, escaping and empty elements for us. A report
// names suites by their declared `suite:`, carries no absolute path and no
// stack trace, and passes every text through redact() first (TS-3).
import type { CaseResult, SuiteResult } from './exec.js';

/** XML escaping for text and attribute values. A control character XML 1.0 cannot hold becomes U+FFFD. */
export function escapeXml(raw: string): string {
  return raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '�')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export type Redact = (text: string) => string;
const keep: Redact = text => text;

function counts(cases: CaseResult[]) {
  const passed = cases.filter(c => c.status === 'passed').length;
  const failed = cases.filter(c => c.status === 'failed' || c.status === 'error').length;
  const skipped = cases.filter(c => c.status === 'skipped').length;
  return { total: cases.length, passed, failed, skipped };
}

const word = (status: CaseResult['status']) => (status === 'passed' ? 'Passed' : status === 'skipped' ? 'Skipped' : 'Failed');
const seconds = (cases: CaseResult[]) => cases.reduce((n, c) => n + c.durationSec, 0).toFixed(3);
const stamp = (now: Date) => now.toISOString().replace('T', ' ').replace(/\.[0-9]{3}Z$/, 'Z');
const trimEnd = (s: string) => s.replace(/[\n\r\t ]+$/, '');

/** NUnit 3: one test-run, a test-suite per suite file, a test-case per case. */
export function nunit3(suites: SuiteResult[], redact: Redact = keep, now = new Date()): string {
  const all = suites.flatMap(s => s.cases);
  const t = counts(all);
  const at = stamp(now);
  const x = (s: string) => escapeXml(redact(s));
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    `<test-run id="2" testcasecount="${t.total}" result="${t.failed ? 'Failed' : 'Passed'}" total="${t.total}" passed="${t.passed}" failed="${t.failed}" inconclusive="0" skipped="${t.skipped}" asserts="0" engine-version="1.0" clr-version="node" start-time="${at}" end-time="${at}" duration="${seconds(all)}">`];
  let suiteId = 1000;
  let caseId = 2000;
  for (const suite of suites) {
    const c = counts(suite.cases);
    const name = x(suite.name);
    out.push(`  <test-suite type="TestFixture" id="0-${++suiteId}" name="${name}" fullname="${name}" classname="${name}" runstate="Runnable" testcasecount="${c.total}" result="${c.failed ? 'Failed' : 'Passed'}" start-time="${at}" end-time="${at}" duration="${seconds(suite.cases)}" total="${c.total}" passed="${c.passed}" failed="${c.failed}" inconclusive="0" skipped="${c.skipped}" asserts="0">`);
    for (const one of suite.cases) {
      const caseName = x(one.name);
      out.push(`    <test-case id="0-${++caseId}" name="${caseName}" fullname="${name}.${caseName}" methodname="${caseName}" classname="${name}" runstate="Runnable" result="${word(one.status)}" start-time="${at}" end-time="${at}" duration="${one.durationSec.toFixed(3)}" asserts="0">`);
      if (one.status === 'failed' || one.status === 'error') out.push('      <failure>', `        <message>${x(one.message)}</message>`, '      </failure>');
      if (one.status === 'skipped') out.push('      <reason>', `        <message>${x(one.message)}</message>`, '      </reason>');
      if (one.output) out.push(`      <output>${x(trimEnd(one.output))}</output>`);
      out.push('    </test-case>');
    }
    out.push('  </test-suite>');
  }
  out.push('</test-run>');
  return `${out.join('\n')}\n`;
}

/** JUnit: a testsuite per suite file, a testcase per case, failures and skips as elements. */
export function junit(suites: SuiteResult[], redact: Redact = keep): string {
  const x = (s: string) => escapeXml(redact(s));
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<testsuites>'];
  for (const suite of suites) {
    const c = counts(suite.cases);
    const name = x(suite.name);
    out.push(`  <testsuite name="${name}" tests="${c.total}" failures="${c.failed}" skipped="${c.skipped}">`);
    for (const one of suite.cases) {
      out.push(`    <testcase name="${x(one.name)}" classname="${name}" time="${one.durationSec.toFixed(3)}">`);
      if (one.status === 'failed' || one.status === 'error') out.push(`      <failure message="${x(one.message)}"></failure>`);
      if (one.status === 'skipped') out.push(`      <skipped message="${x(one.message)}"></skipped>`);
      out.push(`      <system-out>${x(trimEnd(one.output))}</system-out>`, '    </testcase>');
    }
    out.push('  </testsuite>');
  }
  out.push('</testsuites>');
  return `${out.join('\n')}\n`;
}
