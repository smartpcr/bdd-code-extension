import * as assert from 'assert';
import { test } from 'node:test';
import { newerInstalled, parseVersion } from '../../src/core/selfUpdate';

test('parseVersion: major.minor.patch only', () => {
  assert.deepStrictEqual(parseVersion('0.4.10'), [0, 4, 10]);
  assert.strictEqual(parseVersion('0.4'), undefined);
  assert.strictEqual(parseVersion('0.4.0-beta'), undefined);
});

test('newerInstalled: the newest copy of this extension above the running version', () => {
  const id = 'asz.bdd-suite';
  const folders = ['asz.bdd-suite-0.3.2', 'asz.bdd-suite-0.4.0', 'ASZ.bdd-suite-0.10.1', 'asz.bdd-suite-0.9.9', 'other.ext-9.9.9', 'asz.bdd-suite-x', '.obsolete'];
  assert.strictEqual(newerInstalled(folders, new Set(), id, '0.4.0'), '0.10.1', 'numeric, not text, order; the id in any case');
  assert.strictEqual(newerInstalled(folders, new Set(['ASZ.bdd-suite-0.10.1']), id, '0.4.0'), '0.9.9', 'an obsolete folder does not count');
  assert.strictEqual(newerInstalled(['asz.bdd-suite-0.4.0', 'asz.bdd-suite-0.3.2'], new Set(), id, '0.4.0'), undefined, 'nothing newer');
  assert.strictEqual(newerInstalled(['asz.bdd-suite-1.0.0'], new Set(), id, 'dev'), undefined, 'a running version that is not one');
});
