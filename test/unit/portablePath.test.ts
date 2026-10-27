// src/core/portablePath.ts: the path arithmetic src/core uses in place of
// Node's `path` (YB-1.7). It must answer as Node's `path` does on each
// platform, for every path VS Code hands the extension, and as POSIX with no
// `process` (a browser).
import * as assert from 'assert';
import * as path from 'path';
import { test } from 'node:test';
import { dirname, hostOf, isAbsolute, PathHost, pathOps, relative, resolve, sepOf } from '../../src/core/portablePath';

const host = (windows: boolean, cwd?: string): () => PathHost => () => ({ windows, cwd: () => cwd });
const win = pathOps(host(true, 'C:\\work\\repo'));
const posix = pathOps(host(false, '/work/repo'));
const browser = pathOps(() => hostOf({}));

// Paths that never reach the working folder, so Node's answer does not depend on where the test runs.
const WIN_RESOLVE: string[][] = [
  ['C:\\a\\b', '..\\c'], ['C:/a/b/', './c/../d'], ['c:\\a', 'D:\\b', 'e'], ['C:\\a', '\\b'], ['C:\\', ''],
  ['C:\\a\\..\\..'], ['\\\\srv\\share\\x', '..\\..\\y'], ['\\\\srv\\share'], ['//srv/share/a/b'], ['C:\\a\\b', 'C:\\c', 'd'],
  ['D:\\x', 'c:\\y', 'C:z'],
];
const WIN_DIRNAME = ['C:\\a\\b', 'C:\\a\\b\\', 'C:\\a', 'C:\\', 'C:', 'C:a', 'C:a\\b', '\\a', '\\', '\\\\srv\\share',
  '\\\\srv\\share\\', '\\\\srv\\share\\a', '\\\\srv', 'a', 'a\\b', 'a/b//c', '', 'C:/a/b', '//a', 'C:\\a\\\\b'];
const WIN_ABSOLUTE = ['C:\\a', 'C:/a', 'C:a', 'C:', '\\a', '/a', '\\\\srv\\share', 'a', ''];
const WIN_RELATIVE: [string, string][] = [
  ['C:\\a\\b', 'C:\\a\\c'], ['C:\\a', 'C:\\a\\b\\c'], ['C:\\a\\b\\c', 'C:\\a'], ['C:\\A\\b', 'c:\\a\\B'], ['C:\\a', 'D:\\a'],
  ['C:\\', 'C:\\x'], ['C:\\x\\y', 'C:\\'], ['C:\\ab', 'C:\\ac'], ['C:\\Foo\\bar', 'c:\\foo\\BAZ'], ['C:\\a', 'C:\\a'],
  ['\\\\srv\\share\\a', '\\\\srv\\other\\b'], ['\\\\srv\\share\\a', 'C:\\a'], ['C:/a/b', 'C:\\a\\b\\c'],
];
const POSIX_RESOLVE: string[][] = [['/a/b', '../c'], ['/a/b/', './c/../d'], ['/a', '/b', 'c'], ['/', ''], ['/a/../..'], ['/a', 'b\\c']];
const POSIX_DIRNAME = ['/a/b', '/a/b/', '/a', '/', '//a', 'a', 'a/b', '', 'a//b', '/a//b', 'a\\b'];
const POSIX_RELATIVE: [string, string][] = [['/a/b', '/a/c'], ['/a', '/a/b/c'], ['/a/b/c', '/a'], ['/', '/x'], ['/x/y', '/'],
  ['/ab', '/ac'], ['/a/b', '/a/bc'], ['/A', '/a'], ['/a', '/a'], ['/a', '/b']];

test('Windows rules answer as path.win32 for absolute paths, drives and UNC shares', () => {
  for (const args of WIN_RESOLVE) assert.strictEqual(win.resolve(...args), path.win32.resolve(...args), `resolve ${args.join(' , ')}`);
  for (const p of WIN_DIRNAME) assert.strictEqual(win.dirname(p), path.win32.dirname(p), `dirname ${p}`);
  for (const p of WIN_ABSOLUTE) assert.strictEqual(win.isAbsolute(p), path.win32.isAbsolute(p), `isAbsolute ${p}`);
  for (const [f, t] of WIN_RELATIVE) assert.strictEqual(win.relative(f, t), path.win32.relative(f, t), `relative ${f} -> ${t}`);
  assert.strictEqual(win.sepOf('/a'), '\\');
});

test('POSIX rules answer as path.posix', () => {
  for (const args of POSIX_RESOLVE) assert.strictEqual(posix.resolve(...args), path.posix.resolve(...args), `resolve ${args.join(' , ')}`);
  for (const p of POSIX_DIRNAME) assert.strictEqual(posix.dirname(p), path.posix.dirname(p), `dirname ${p}`);
  for (const p of ['/a', 'a', '']) assert.strictEqual(posix.isAbsolute(p), path.posix.isAbsolute(p), `isAbsolute ${p}`);
  for (const [f, t] of POSIX_RELATIVE) assert.strictEqual(posix.relative(f, t), path.posix.relative(f, t), `relative ${f} -> ${t}`);
  assert.strictEqual(posix.sepOf('/a', 'b'), '/');
});

test('the module answers as Node path on this host, relative paths against process.cwd()', () => {
  const cases = [['a', 'b'], ['..', 'x'], [], [''], ['/r/test/e2e/suites/demo.yml'], ['/r/a', '../b/./c.yml'], [process.cwd(), 'x']];
  for (const args of cases) assert.strictEqual(resolve(...args), path.resolve(...args), `resolve ${args.join(' , ')}`);
  for (const p of ['a/b', '/r/a/b', path.resolve('x/y'), '']) assert.strictEqual(dirname(p), path.dirname(p), `dirname ${p}`);
  for (const p of ['a', '/r/a', path.resolve('x')]) assert.strictEqual(isAbsolute(p), path.isAbsolute(p), `isAbsolute ${p}`);
  for (const [f, t] of [['/r/a/b', '/r/c'], ['x', 'x/y'], [path.resolve('a'), path.resolve('b/c')]]) {
    assert.strictEqual(relative(f!, t!), path.relative(f!, t!), `relative ${f} -> ${t}`);
  }
  assert.strictEqual(sepOf(path.resolve('a')), path.sep);
});

test('drive-relative paths resolve against the working folder on its drive, else the drive root', () => {
  assert.strictEqual(win.resolve('c:x'), 'c:\\work\\repo\\x', 'the same drive, in another case');
  assert.strictEqual(win.resolve('D:x'), 'D:\\x');
  assert.strictEqual(win.resolve('C:\\a', 'D:x'), 'D:\\x', 'another drive skips the earlier segments');
  assert.strictEqual(win.resolve('x', '..\\y'), 'C:\\work\\repo\\y', 'a relative path takes the working folder');
  assert.strictEqual(win.resolve('/x'), 'C:\\x', "a rooted path takes the working folder's drive");
});

test('with no process (a browser): POSIX rooted at /, and Windows-shaped paths by Windows rules', () => {
  assert.strictEqual(browser.resolve('suites/a.yml'), '/suites/a.yml');
  assert.strictEqual(browser.resolve(), '/');
  assert.strictEqual(browser.resolve('/suites/x', '../_lib/lib.yml'), '/suites/_lib/lib.yml');
  assert.strictEqual(browser.dirname('/suites/a.yml'), '/suites');
  assert.strictEqual(browser.relative('/schema', '/bindings/cs'), '../bindings/cs');
  assert.strictEqual(browser.isAbsolute('/a'), true);
  assert.strictEqual(browser.isAbsolute('C:\\a'), true);
  assert.strictEqual(browser.resolve('C:\\w\\suites', '../schema/a.yaml'), 'C:\\w\\schema\\a.yaml');
  assert.strictEqual(browser.resolve('\\a', 'b'), '\\a\\b', 'rooted with no device: no working folder to take one from');
  assert.strictEqual(browser.resolve('C:x'), 'C:x', 'drive-relative with no working folder stays relative');
  assert.strictEqual(browser.relative('\\a', '\\a\\b'), 'b');
  assert.strictEqual(browser.relative('\\a', '\\b'), '\\b', 'nothing in common: the target itself');
  assert.strictEqual(browser.sepOf('/a'), '/');
  assert.strictEqual(browser.sepOf('/a', 'C:\\b'), '\\');
});

test('a host with a relative or empty working folder resolves relative paths relatively', () => {
  const relativeCwd = pathOps(host(false, ''));
  assert.strictEqual(relativeCwd.resolve('a', '..'), '.');
  assert.strictEqual(relativeCwd.resolve('../x', '..', '..'), '../..', 'a .. above the start is kept');
  assert.strictEqual(pathOps(host(false, 'w')).resolve('a'), 'w/a');
  assert.strictEqual(pathOps(host(true)).resolve('a', '..'), '.', 'Windows rules with no working folder');
});

test('hostOf reads process.platform and process.cwd, and stands for no host without them', () => {
  const none = hostOf({});
  assert.deepStrictEqual([none.windows, none.cwd()], [false, undefined]);
  const proc = { platform: 'win32', dir: 'C:\\w', cwd(this: { dir: string }) { return this.dir; } };
  const w = hostOf({ process: proc });
  assert.deepStrictEqual([w.windows, w.cwd()], [true, 'C:\\w'], 'cwd is called on process');
  const odd = hostOf({ process: { platform: 'linux', cwd: '/not-a-function' } });
  assert.deepStrictEqual([odd.windows, odd.cwd()], [false, undefined]);
});
