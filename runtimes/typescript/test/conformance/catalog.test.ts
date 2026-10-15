// TS-6: the core catalog agrees with what this runtime registers. Every core
// action the catalog lists for typescript is registered, and nothing else is,
// so a core action cannot be implemented without being declared or declared
// without being implemented. A workspace's own actions come from extensions.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { allNames } from '../../src/exec.js';
import { coreCatalog } from '../where.js';

test('B7.5-2 the core catalog\'s typescript set is exactly the registered names', () => {
  const catalog = parse(fs.readFileSync(coreCatalog, 'utf8')) as { actions: { name: string; bindings: string[] }[] };
  const declared = catalog.actions.filter(a => a.bindings.includes('typescript')).map(a => a.name).sort();
  const registered = allNames();
  console.log(`  ${registered.length} registered: ${registered.join(', ')}`);
  assert.deepEqual(registered, declared);
});
