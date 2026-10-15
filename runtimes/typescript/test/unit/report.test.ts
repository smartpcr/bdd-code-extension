// report.ts and the test canonicaliser: escaping, each result's element, redaction, the canonical rules.
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SuiteResult } from '../../src/exec.js';
import { escapeXml, junit, nunit3 } from '../../src/report.js';
import { canonicalise, parseXml } from '../conformance/canonicalise.js';

const suites: SuiteResult[] = [{
  name: 's<1>',
  cases: [
    { name: 'ok', status: 'passed', message: '', output: '{"b":1,"a":2}\n"x"\n', durationSec: 0.5 },
    { name: 'bad & "worse"', status: 'failed', message: "expected 'P' < Q, secret-123", output: '', durationSec: 0.25 },
    { name: 'err', status: 'error', message: 'Suite setup failed', output: '', durationSec: 0 },
    { name: 'skip', status: 'skipped', message: 'tag filter', output: '', durationSec: 0 },
  ],
}];

test('escapeXml: the five entities, and a control character XML cannot hold', () => {
  assert.equal(escapeXml(`<a & "b" 'c'>`), '&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;');
  assert.equal(escapeXml('a\u0001b\tc\nd'), 'a�b\tc\nd');
});

test('nunit3: counts, a failure per failed or errored case, a reason per skip, output, redacted text, a fixed time', () => {
  const xml = nunit3(suites, t => t.replace('secret-123', '[redacted]'), new Date('2026-01-02T03:04:05.678Z'));
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<test-run id="2" testcasecount="4" result="Failed" total="4" passed="1" failed="2" inconclusive="0" skipped="1" asserts="0" engine-version="1.0" clr-version="node" start-time="2026-01-02 03:04:05Z" end-time="2026-01-02 03:04:05Z" duration="0.750">/);
  assert.match(xml, /<test-suite type="TestFixture" id="0-1001" name="s&lt;1&gt;"/);
  assert.match(xml, /<test-case id="0-2002" name="bad &amp; &quot;worse&quot;" fullname="s&lt;1&gt;\.bad &amp; &quot;worse&quot;"/);
  assert.match(xml, /<message>expected &apos;P&apos; &lt; Q, \[redacted\]<\/message>/);
  assert.match(xml, /<reason>\n {8}<message>tag filter<\/message>\n {6}<\/reason>/);
  assert.match(xml, /<output>\{&quot;b&quot;:1,&quot;a&quot;:2\}\n&quot;x&quot;<\/output>/);
  assert.equal((xml.match(/<failure>/g) ?? []).length, 2);
  assert.match(nunit3([{ name: 'p', cases: [{ name: 'c', status: 'passed', message: '', output: '', durationSec: 0 }] }]), /result="Passed"/);
});

test('junit: failure and skipped elements with their message, system-out always present', () => {
  const xml = junit(suites);
  assert.match(xml, /<testsuite name="s&lt;1&gt;" tests="4" failures="2" skipped="1">/);
  assert.match(xml, /<failure message="expected &apos;P&apos; &lt; Q, secret-123"><\/failure>/);
  assert.match(xml, /<skipped message="tag filter"><\/skipped>/);
  assert.equal((xml.match(/<system-out>/g) ?? []).length, 4);
});

test('canonicalise: what was measured goes, what happened stays; JSON lines sorted; stack traces and JUnit failure text dropped', () => {
  const a = '<test-run id="2" duration="9.000" total="1"><test-case id="0-1" name="c" result="Passed" duration="9.000"><output>{"b":1,"a":{"d":1,"c":[2,1]}}\r\nplain  </output></test-case></test-run>';
  const b = a.replace(/9\.000/g, '0.125').replace('id="2"', 'id="7"');
  assert.equal(canonicalise(a), canonicalise(b));
  assert.notEqual(canonicalise(a), canonicalise(a.replace('Passed', 'Failed')));
  assert.equal(canonicalise(a), '<test-run total="1">\n  <test-case name="c" result="Passed">\n    <output>\n      {"a":{"c":[2,1],"d":1},"b":1}\n      plain\n    </output>\n  </test-case>\n</test-run>\n');
  const nunit = canonicalise('<?xml version="1.0"?><r><!-- note --><test-case name="c"><failure><message>why</message><stack-trace>at x:1</stack-trace></failure><output>  </output><x>{not json}</x></test-case></r>');
  assert.equal(nunit, '<r>\n  <test-case name="c">\n    <failure>\n      <message>why</message>\n    </failure>\n    <output/>\n    <x>{not json}</x>\n  </test-case>\n</r>\n');
  assert.equal(canonicalise('<r><testcase name="c"><failure message="w&amp;y">at x:1</failure></testcase></r>'), '<r>\n  <testcase name="c">\n    <failure message="w&y"/>\n  </testcase>\n</r>\n');
  assert.equal(canonicalise('<r>lead<a/></r>'), '<r>\n  lead\n  <a/>\n</r>\n');
  assert.equal(canonicalise('<only/>'), '<only/>\n');
  assert.throws(() => parseXml('<a></b>'), /not balanced/);
  assert.throws(() => parseXml('</a>'), /not balanced/);
  assert.throws(() => parseXml('text only'), /root element/);
});
