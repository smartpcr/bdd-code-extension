// session: oscontext
// B1.1-1: the extension activates in os-context and names the root and catalog.
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { api, folder, key } from './helpers';

describe('B1.1 activation in os-context', () => {
  it('B1.1-1 activates on the catalog, and the first log line names the root and the catalog', async () => {
    const ext = vscode.extensions.getExtension('local.bdd-suite')!;
    const a = await api();
    assert.ok(ext.isActive);
    const first = a.log[0];
    const catalog = path.join(folder(), 'test', 'e2e', 'schema', 'actions.catalog.yaml');
    assert.match(first, /^Root: .+  Catalog: .+$/);
    assert.ok(key(first).includes(`root: ${key(folder())}`), first);
    assert.ok(key(first).endsWith(key(catalog)), first);
    assert.strictEqual(a.providerCount, 4);
    assert.strictEqual(a.indexers.length, 1);
    console.log(`    log: ${a.log.join(' | ')}`);
  });
});
