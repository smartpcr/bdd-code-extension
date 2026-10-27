// session: empty
// Suite: Create suites workspace skeleton, from a window with no catalog: the
// command is there, writes a workspace and its generated schema into a new
// folder, never overwrites, and refuses a folder that has a catalog already.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SkeletonResult } from '../../../src/features/skeleton';

const create = (args: object) => vscode.commands.executeCommand<SkeletonResult>('bddSuite.createSkeleton', { open: false, ...args });

describe('Suite: Create suites workspace skeleton', () => {
  const made: string[] = [];
  const folder = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-skeleton-'));
    made.push(dir);
    return dir;
  };
  before(async () => {
    await vscode.extensions.getExtension('asz.bdd-suite')!.activate();
  });
  after(() => {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is a command of the palette in a window with no catalog', async () => {
    assert.ok((await vscode.commands.getCommands(true)).includes('bddSuite.createSkeleton'));
  });

  it('writes a C# and PowerShell workspace and generates its schema', async () => {
    const target = folder();
    const r = await create({ target, languages: ['csharp', 'powershell'], name: 'order-service' });
    assert.ok(r.ok, r.message);
    assert.strictEqual(r.generator, 'exit 0', r.message);
    assert.deepStrictEqual(r.skipped, []);
    for (const f of ['.vscode/settings.json', 'schema/actions.catalog.yaml', 'suites/order-service.yml', 'README.md', '.gitignore',
      'bindings/dotnet/OrderService.Suite/OrderServiceExtension.cs', 'bindings/dotnet/Directory.Packages.props',
      'bindings/powershell/OrderService/actions/OrderServiceEcho.ps1', 'packages.psd1']) {
      assert.ok(r.files.includes(f), `${f} is written; written: ${r.files.join(', ')}`);
      assert.ok(fs.existsSync(path.join(target, f)), f);
    }
    const schema = fs.readFileSync(path.join(target, 'schema', 'suite.schema.json'), 'utf8');
    assert.match(schema, /orderService\.echo/, 'the generated schema has the first action');
    const version = String((vscode.extensions.getExtension('asz.bdd-suite')!.packageJSON as { version: string }).version);
    assert.match(fs.readFileSync(path.join(target, 'bindings/dotnet/Directory.Packages.props'), 'utf8'), new RegExp(`>${version.replace(/\./g, '\\.')}<`));

    const again = await create({ target, languages: ['csharp'], name: 'order-service' });
    assert.ok(!again.ok);
    assert.match(again.message, /is a suites workspace already/);
  });

  it('keeps a file that is there and writes the rest', async () => {
    const target = folder();
    fs.writeFileSync(path.join(target, 'README.md'), 'mine\n');
    const r = await create({ target, languages: ['powershell'], name: 'shop' });
    assert.ok(r.ok, r.message);
    assert.deepStrictEqual(r.skipped, ['README.md']);
    assert.strictEqual(fs.readFileSync(path.join(target, 'README.md'), 'utf8'), 'mine\n');
    assert.ok(fs.existsSync(path.join(target, 'bindings/powershell/Shop/Shop.psm1')));
  });

  it('refuses a language it has no skeleton for, and a bad name', async () => {
    const target = folder();
    const go = await create({ target, languages: ['go'], name: 'shop' });
    assert.ok(!go.ok);
    assert.match(go.message, /no skeleton for go/);
    const bad = await create({ target, languages: ['csharp'], name: 'Shop' });
    assert.ok(!bad.ok);
    assert.match(bad.message, /lower-case letters/);
    assert.deepStrictEqual(fs.readdirSync(target), [], 'nothing is written');
  });
});
