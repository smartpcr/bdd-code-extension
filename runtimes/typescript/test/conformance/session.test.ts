// E1 for TypeScript (docs/test-providers/design.md): every execute entry,
// driven through the session as a test framework drives it (the class hook's
// setup, each case, the class hook's teardown), emits the expected trace in
// file order and, with the cases reversed, the expectation with each case's
// entries moved as a group; and the case results equal the whole-file run's.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { coreActions } from '../../src/actions/core.js';
import { CaseResult, RunOptions, runFile } from '../../src/exec.js';
import { compose, start } from '../../src/extension.js';
import { loadDocument } from '../../src/model.js';
import { loadSchema } from '../../src/schema.js';
import { createRunContext, openSession } from '../../src/session.js';
import { Entry, Trace } from '../../src/trace.js';
import { ValueMap } from '../../src/value.js';
import { corpus, corpusExtension, corpusSchema } from '../where.js';

type ManifestEntry = { kind: string; suite: string; expectation: string; params?: Record<string, unknown>; tags?: string };

const line = (e: Partial<Entry>) => [e.phase, e.case ?? '', e.step ?? '', e.action ?? '', e.status, e.reason ?? ''].join(' | ');

/** An expectation with its per-case groups in reverse order: the setup's entries first, the teardown's last. */
function casesReversed(entries: Partial<Entry>[]): string[] {
  const setup = entries.filter(e => e.phase === 'suite-setup').map(line);
  const teardown = entries.filter(e => e.phase === 'suite-teardown').map(line);
  const groups: { name: string; lines: string[] }[] = [];
  for (const e of entries.filter(x => x.phase !== 'suite-setup' && x.phase !== 'suite-teardown')) {
    if (groups.at(-1)?.name === e.case) groups.at(-1)!.lines.push(line(e));
    else groups.push({ name: e.case!, lines: [line(e)] });
  }
  return [...setup, ...groups.reverse().flatMap(g => g.lines), ...teardown];
}

const summary = (r: CaseResult) => `${r.name}|${r.status}|${r.message}`;

test('E1 every execute entry through the session, in file order and reversed', async () => {
  const manifest = parse(fs.readFileSync(path.join(corpus, 'run-manifest.yaml'), 'utf8')) as { entries: ManifestEntry[] };
  const schema = loadSchema(corpusSchema);
  const composite = compose([corpusExtension], coreActions);
  const wrong: string[] = [];
  let checked = 0;
  for (const entry of manifest.entries.filter(e => e.kind === 'execute')) {
    const file = path.join(corpus, entry.suite);
    const suite = () => loadDocument(fs.readFileSync(file, 'utf8')).value as ValueMap;
    const wanted = (JSON.parse(fs.readFileSync(path.join(corpus, entry.expectation), 'utf8')) as { trace: Partial<Entry>[] }).trace;
    const options: RunOptions = {
      tags: (entry.tags ?? '').split(',').map(t => t.trim()).filter(Boolean),
      params: Object.entries(entry.params ?? {}).map(([k, v]) => [k, String(v)]), dryRun: false, recordPath: '', env: {},
    };
    const drive = async (reversed: boolean) => {
      const context = createRunContext({ composite, started: start(composite, new Map()) }, options);
      const session = openSession(file, suite(), schema, context);
      await session.setup();
      const order = session.cases.map((_, i) => i);
      if (reversed) order.reverse();
      const results: string[] = [];
      for (const index of order) {
        await session.beforeEach(index);
        await session.runCase(index);
        results.push(summary(await session.afterEach(index)));
      }
      await session.teardown();
      return { lines: context.trace.entries.map(line), results };
    };
    const inOrder = await drive(false);
    if (inOrder.lines.join('\n') !== wanted.map(line).join('\n')) wrong.push(`${entry.suite} (file order):\n${inOrder.lines.join('\n')}`);
    const reversed = await drive(true);
    if (reversed.lines.join('\n') !== casesReversed(wanted).join('\n')) wrong.push(`${entry.suite} (reversed):\n${reversed.lines.join('\n')}`);
    const whole = await runFile(file, suite(), schema, options, new Trace(), { composite, started: start(composite, new Map()) });
    const wholeCases = whole.cases.filter(c => c.name !== 'teardown').map(summary);
    if (wholeCases.join('\n') !== inOrder.results.join('\n')) wrong.push(`${entry.suite}: results differ from the whole-file run`);
    checked++;
  }
  assert.equal(checked, 14);
  assert.deepEqual(wrong, []);
});
