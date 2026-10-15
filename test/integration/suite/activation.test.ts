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
    assert.strictEqual(a.providerCount, 7);
    assert.strictEqual(a.indexers.length, 1);
    console.log(`    log: ${a.log.join(' | ')}`);
  });

  it('B9.2 with --vsix: the extension running is the installed package, not this source tree', function () {
    const dir = process.env.BDD_VSIX_EXTENSIONS_DIR;
    if (!dir) this.skip();
    const ext = vscode.extensions.getExtension('local.bdd-suite')!;
    assert.ok(key(ext.extensionPath).startsWith(key(dir!)), `${ext.extensionPath} is not under ${dir}`);
    assert.strictEqual(ext.packageJSON.version, process.env.BDD_VSIX_VERSION);
    assert.ok(!require('fs').existsSync(path.join(ext.extensionPath, 'src')), 'the package has no src/');
    console.log(`    running ${ext.id}@${ext.packageJSON.version} from ${ext.extensionPath}`);
  });
});
