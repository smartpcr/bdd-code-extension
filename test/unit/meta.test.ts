// B1.6: visibleMetaSteps, metaTargetOf, metaDefinitionAt, metaUses.
import * as assert from 'assert';
import * as path from 'path';
import { test } from 'node:test';
import { parseSuite } from '../../src/core/suites';
import { WorkspaceIndex } from '../../src/core/workspaceIndex';

const d = path.resolve('/r/s');
const f = (n: string) => path.join(d, n);
const meta = (name: string, action = 'core.noop') => `  - name: ${name}\n    steps:\n      - action: ${action}\n`;

function build(files: Record<string, string>): WorkspaceIndex {
  const ix = new WorkspaceIndex();
  for (const [name, text] of Object.entries(files)) ix.updateSuite(parseSuite(text, f(name)));
  return ix;
}

const USE = (imports: string[], extra = '') => `suite: s\nimports: [${imports.join(', ')}]\n${extra}tests:\n  - name: c\n    steps:\n      - meta: shared\n      - meta: deep\n      - meta: missing\n`;

test('B1.6 imported, two-level, local shadowing, missing', () => {
  const ix = build({
    's.yml': USE(['a.yml'], `metaSteps:\n${meta('local')}`),
    'a.yml': `imports: [b.yml]\nmetaSteps:\n${meta('shared', 'from.a')}`,
    'b.yml': `metaSteps:\n${meta('shared', 'from.b')}${meta('deep')}`,
  });
  const visible = ix.visibleMetaSteps(f('s.yml'));
  assert.deepStrictEqual([...visible.keys()].sort(), ['deep', 'local', 'shared']);
  assert.strictEqual(path.basename(visible.get('shared')!.file), 'a.yml', 'a later (nearer) definition replaces the deeper one');
  assert.strictEqual(path.basename(visible.get('deep')!.file), 'b.yml');
  const steps = ix.suite(f('s.yml'))!.steps.filter(s => s.meta);
  assert.strictEqual(path.basename(ix.metaTargetOf(steps[0])!.file), 'a.yml');
  assert.strictEqual(ix.metaTargetOf(steps[2]), undefined);
  assert.strictEqual(ix.metaTargetOf(ix.suite(f('b.yml'))!.steps[0]), undefined, 'a step without meta');
});

test('B1.6-1 a local definition shadows an imported one', () => {
  const ix = build({
    's.yml': USE(['a.yml'], `metaSteps:\n${meta('shared', 'mine')}`),
    'a.yml': `metaSteps:\n${meta('shared', 'theirs')}`,
  });
  assert.strictEqual(path.basename(ix.visibleMetaSteps(f('s.yml')).get('shared')!.file), 's.yml');
});

test('B1.6-2 an import cycle terminates and resolves what it can', () => {
  const ix = build({
    's.yml': USE(['a.yml']),
    'a.yml': `imports: [b.yml]\nmetaSteps:\n${meta('shared')}`,
    'b.yml': `imports: [a.yml, s.yml]\nmetaSteps:\n${meta('deep')}`,
  });
  assert.deepStrictEqual([...ix.visibleMetaSteps(f('s.yml')).keys()].sort(), ['deep', 'shared']);
});

test('the import depth limit stops resolution', () => {
  const files: Record<string, string> = { 's.yml': USE(['l0.yml']) };
  for (let i = 0; i < 8; i++) files[`l${i}.yml`] = `imports: [l${i + 1}.yml]\nmetaSteps:\n${meta(`m${i}`)}`;
  const ix = build(files);
  const keys = [...ix.visibleMetaSteps(f('s.yml')).keys()];
  assert.ok(keys.includes('m4'));
  assert.ok(!keys.includes('m5'));
});

test('metaDefinitionAt and metaUses', () => {
  const ix = build({
    's.yml': USE(['a.yml']),
    't.yml': USE(['a.yml']).replace('suite: s', 'suite: t'),
    'u.yml': `suite: u\nmetaSteps:\n${meta('shared')}tests:\n  - name: c\n    steps:\n      - meta: shared\n`,
    'a.yml': `metaSteps:\n${meta('shared')}${meta('deep')}`,
  });
  const lib = ix.suite(f('a.yml'))!;
  const target = ix.metaDefinitionAt(f('a.yml'), lib.metaSteps[0].nameRange.start)!;
  assert.strictEqual(target.def.name, 'shared');
  assert.deepStrictEqual(ix.metaUses(target).map(s => path.basename(s.file)).sort(), ['s.yml', 't.yml']);
  assert.strictEqual(ix.metaDefinitionAt(f('a.yml'), { line: 0, character: 0 }), undefined);
  assert.strictEqual(ix.metaDefinitionAt(f('nope.yml'), { line: 0, character: 0 }), undefined);
});
