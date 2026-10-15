// E3, the TypeScript part: an extension built outside the runtime, on its
// public API only, adds an action, a context key, an option and a rule; the
// plain runtime has none of them; two extensions cannot define one action.
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { action } from '../../src/actions/registry.js';
import { main, Streams } from '../../src/cli.js';
import { echo } from '../../example/src/extension.js';
import { pkg } from '../where.js';

const example = path.join(pkg, 'example');
const schemaRoot = path.join(example, 'schema');
const suite = path.join(example, 'suites', 'echo.yml');

async function run(argv: string[], extensions = [echo]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const streams: Streams = { out: t => void (out += t), err: t => void (err += t) };
  const code = await main(argv, streams, extensions);
  return { code, out, err };
}

const lint = (extensions = [echo]) => run(['lint', '--schema-root', schemaRoot, '--path', suite, '--json'], extensions);
const findings = (out: string) => (JSON.parse(out) as { code: string; line: number; column: number }[]).map(d => `${d.code} ${d.line}:${d.column}`);

test('E3 with the extension: the action runs, ${region} reads the option, the rule reports its ceiling', async () => {
  const r = await run(['run', '--schema-root', schemaRoot, '--path', suite, '--region', 'eu']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /\[passed\] echoes-with-the-region/);
  const l = await lint();
  assert.deepEqual([l.code, findings(l.out)], [2, ['E205 5:17']], 'only the rule: timeoutSec 30 in a suite tagged slow');
  const actions = await run(['actions', '--json']);
  assert.ok((JSON.parse(actions.out) as string[]).includes('example.echo'));
});

test('E3 without the extension: ${region} is E301, no ceiling, --region is refused, the action has no handler', async () => {
  const l = await lint([]);
  assert.deepEqual(findings(l.out), ['E301 9:15'], 'the context key is unknown; the slow rule is not there');
  const refused = await run(['run', '--schema-root', schemaRoot, '--path', suite, '--region', 'eu'], []);
  assert.deepEqual([refused.code, /run does not take --region/.test(refused.err)], [2, true]);
  const failed = await run(['run', '--schema-root', schemaRoot, '--path', suite], []);
  assert.equal(failed.code, 1);
  assert.match(failed.out, /\[failed\] echoes-with-the-region/);
});

test('E3 two extensions defining one action are refused before anything runs', async () => {
  const twin = { name: 'twin', actions: [action('example.echo', async () => null)] };
  const r = await run(['actions'], [echo, twin]);
  assert.deepEqual([r.code, r.out], [2, '']);
  assert.match(r.err, /Action example\.echo is defined by both example and twin/);
});

test('E3 the example is its own program, and imports only the package\'s public entry points', () => {
  const cli = path.join(pkg, 'dist-test', 'example', 'src', 'cli.js');
  const r = spawnSync(process.execPath, [cli, 'run', '--schema-root', schemaRoot, '--path', suite, '--region', 'eu'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const file of fs.readdirSync(path.join(example, 'src'))) {
    const imports = [...fs.readFileSync(path.join(example, 'src', file), 'utf8').matchAll(/from '([^']+)'/g)].map(m => m[1]);
    for (const i of imports) assert.ok(['../../src/index.js', '../../src/cli.js', './extension.js'].includes(i!), `${file} imports ${i}`);
  }
});
