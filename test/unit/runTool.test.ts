// B2.1, B2.6: runTool with a real misbehaving child; killTree on both platforms.
import * as assert from 'assert';
import * as path from 'path';
import { test } from 'node:test';
import { killAll, killTree, liveChildren, runTool, ToolCommand } from '../../src/tools/runTool';

const FAKE = path.join(__dirname, '../../../test/fake-tool/fake-suiterun.mjs');
const cmd = (args: string[], over: Partial<ToolCommand> = {}): ToolCommand =>
  ({ argv: [process.execPath, FAKE, ...args], cwd: __dirname, timeoutMs: 10_000, maxStdout: 1024 * 1024, ...over });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

class Token {
  isCancellationRequested = false;
  private readonly listeners: (() => void)[] = [];
  onCancellationRequested(l: () => void) {
    this.listeners.push(l);
    return { dispose: () => undefined };
  }
  cancel() {
    this.isCancellationRequested = true;
    this.listeners.forEach(l => l());
  }
}

test('exits with its code, stdout and the stderr tail', async () => {
  const r = await runTool(cmd(['--exit=2', '--print=[]', '--stderr=oops']));
  assert.deepStrictEqual(r, { kind: 'exited', code: 2, stdout: '[]', stderrTail: 'oops' });
});

test('the stderr tail is bounded', async () => {
  const r = await runTool(cmd(['--stderr=abcdefghij']), undefined, { maxStderr: 4 });
  assert.strictEqual(r.kind === 'exited' && r.stderrTail, 'ghij');
});

test('B2.1-1 a program that is not there is not-found, never an exception', async () => {
  const r = await runTool({ argv: [path.join(__dirname, 'no-such-suiterun.exe'), 'lint'], cwd: __dirname, timeoutMs: 5000, maxStdout: 10 });
  assert.strictEqual(r.kind, 'failure');
  assert.strictEqual(r.kind === 'failure' && r.reason, 'not-found');
});

test('a spawn that throws is a spawn failure', async () => {
  const r = await runTool(cmd([]), undefined, { spawn: (() => { throw new Error('boom'); }) as never });
  assert.deepStrictEqual(r, { kind: 'failure', reason: 'spawn', detail: 'boom', stderrTail: '' });
});

test('a non-ENOENT spawn error is a spawn failure', async () => {
  const r = await runTool({ argv: [process.execPath], cwd: path.join(__dirname, 'no-such-dir'), timeoutMs: 5000, maxStdout: 10 });
  assert.strictEqual(r.kind, 'failure');
  assert.ok(r.kind === 'failure' && ['spawn', 'not-found'].includes(r.reason));
});

test('B2.1-2 a program that outlives its timeout is killed with its children', async () => {
  let grandchild = 0;
  const started = Date.now();
  const r = await runTool(cmd(['--child', '--sleep=60000'], {
    timeoutMs: 1500, onOutput: t => { const m = /grandchild (\d+)/.exec(t); if (m) grandchild = Number(m[1]); },
  }));
  assert.strictEqual(r.kind === 'failure' && r.reason, 'timeout');
  assert.ok(Date.now() - started < 10_000);
  assert.ok(grandchild > 0, 'the grandchild reported its pid');
  await new Promise(res => setTimeout(res, 1000));
  assert.strictEqual(alive(grandchild), false, 'no grandchild survives KILL_GRACE_MS');
  assert.strictEqual(liveChildren.size, 0);
});

test('B2.1-3 more than maxStdout bytes is oversize, and the process is killed', async () => {
  const r = await runTool(cmd(['--bytes=200000', '--sleep=0'], { maxStdout: 1000 }));
  assert.strictEqual(r.kind === 'failure' && r.reason, 'oversize');
});

test('B2.1-4 cancellation kills and returns cancelled; an already cancelled token starts nothing', async () => {
  const token = new Token();
  const p = runTool(cmd(['--sleep=60000']), token);
  setTimeout(() => token.cancel(), 300);
  assert.deepStrictEqual(await p, { kind: 'cancelled' });
  const t2 = new Token();
  t2.cancel();
  let spawned = false;
  assert.deepStrictEqual(await runTool(cmd([]), t2, { spawn: (() => { spawned = true; }) as never }), { kind: 'cancelled' });
  assert.strictEqual(spawned, false);
});

test('B2.1-5 an argument with spaces, quotes and $ reaches the program unchanged', async () => {
  const weird = `a b "c" 'd' $e \${f}.yml`;
  const r = await runTool(cmd(['--echo-argv', 'lint', '--path', weird]));
  assert.deepStrictEqual(r.kind === 'exited' && JSON.parse(r.stdout), ['lint', '--path', weird]);
});

test('onOutput streams stdout and stderr', async () => {
  const seen: string[] = [];
  await runTool(cmd(['--print=out', '--stderr=err'], { onOutput: t => seen.push(t) }));
  assert.deepStrictEqual(seen.sort(), ['err', 'out']);
});

test('B2.6-1 with the gate shut, spawn is never called', async () => {
  const r = await runTool(cmd([]), undefined, {
    gate: () => false,
    spawn: (() => assert.fail('spawn must not be called')) as never,
  });
  assert.deepStrictEqual(r, { kind: 'failure', reason: 'untrusted', detail: 'The workspace is not trusted.', stderrTail: '' });
});

test('shell commands run through the shell', async () => {
  const r = await runTool({ argv: ['echo built'], cwd: __dirname, shell: true, timeoutMs: 5000, maxStdout: 1000 });
  assert.ok(r.kind === 'exited' && r.stdout.includes('built'));
});

test('killTree: taskkill on Windows; a process group then the pid elsewhere', () => {
  const calls: unknown[] = [];
  killTree(42, { platform: 'win32', spawnSync: ((...a: unknown[]) => { calls.push(a); }) as never, kill: () => undefined });
  assert.deepStrictEqual(calls, [['taskkill', ['/PID', '42', '/T', '/F'], { windowsHide: true, stdio: 'ignore' }]]);
  const kills: number[] = [];
  killTree(42, { platform: 'linux', spawnSync: (() => undefined) as never, kill: pid => { kills.push(pid); } });
  assert.deepStrictEqual(kills, [-42]);
  const kills2: number[] = [];
  killTree(42, { platform: 'linux', spawnSync: (() => undefined) as never,
    kill: pid => { kills2.push(pid); if (pid < 0) throw new Error('no group'); } });
  assert.deepStrictEqual(kills2, [-42, 42]);
  killTree(42, { platform: 'darwin', spawnSync: (() => undefined) as never, kill: () => { throw new Error('gone'); } });
});

test('killAll kills every live child and empties the set', () => {
  liveChildren.add(7);
  liveChildren.add(8);
  const killed: number[] = [];
  killAll({ platform: 'linux', spawnSync: (() => undefined) as never, kill: pid => { killed.push(pid); } });
  assert.deepStrictEqual(killed, [-7, -8]);
  assert.strictEqual(liveChildren.size, 0);
  killAll();
});

test('a second stop request after the first is ignored', async () => {
  const token = new Token();
  const p = runTool(cmd(['--sleep=60000']), token);
  setTimeout(() => { token.cancel(); token.cancel(); }, 300);
  assert.deepStrictEqual(await p, { kind: 'cancelled' });
});

test('the default kill path tolerates a process that does not exist', () => {
  killTree(2_000_000_000, { platform: 'linux', spawnSync: (() => undefined) as never, kill: (pid, sig) => process.kill(pid, sig) });
  const { defaultDeps } = require('../../src/tools/runTool');
  killTree(2_000_000_000, { ...defaultDeps, platform: 'linux' });
});

test('an error event other than ENOENT is a spawn failure', async () => {
  const { EventEmitter } = require('events');
  const fake = Object.assign(new EventEmitter(), { pid: undefined, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const p = runTool(cmd([]), undefined, { spawn: (() => fake) as never });
  fake.emit('error', Object.assign(new Error('denied'), { code: 'EACCES' }));
  assert.deepStrictEqual(await p, { kind: 'failure', reason: 'spawn', detail: 'denied', stderrTail: '' });
});
