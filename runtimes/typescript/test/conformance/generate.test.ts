// E3 for TypeScript (docs/test-providers/design.md): every generate entry of
// the manifest not pending for TypeScript, through the program: the plan
// suiterun generate --plan prints, compared with the expected plan as JSON, or
// the refusal's exit code and findings.
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { corpus, corpusCli } from '../where.js';

type GenerateEntry = { config: string; expected?: string; exitCode: number; diagnostics?: { file: string; code: string; line: number; column: number }[]; pendingIn?: string[] };

test('E3 every generate entry of the manifest', () => {
  const manifest = parse(fs.readFileSync(path.join(corpus, 'run-manifest.yaml'), 'utf8')) as { generate: GenerateEntry[] };
  const entries = manifest.generate.filter(e => !(e.pendingIn ?? []).includes('typescript'));
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    const config = path.join(corpus, entry.config);
    const r = spawnSync(process.execPath, [corpusCli, 'generate', '--config', config, '--plan'], { encoding: 'utf8' });
    assert.equal(r.status, entry.exitCode, `${entry.config}: ${r.stderr}`);
    if (entry.expected) {
      assert.deepEqual(JSON.parse(r.stdout), JSON.parse(fs.readFileSync(path.join(corpus, entry.expected), 'utf8')), entry.config);
    } else {
      const found = [...r.stderr.matchAll(/^(?:suiterun: )?(\S+):(\d+):(\d+) +([EW]\d+)/gm)].map(m => `${m[1]}:${m[2]}:${m[3]} ${m[4]}`);
      assert.deepEqual(found, entry.diagnostics!.map(d => `${d.file}:${d.line}:${d.column} ${d.code}`), entry.config);
      assert.match(r.stderr, /Nothing was generated/);
    }
  }
});
