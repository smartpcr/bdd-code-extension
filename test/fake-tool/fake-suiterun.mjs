// A program that misbehaves on request, for process-handling tests (plan B2.1).
// Its own flags come first; everything else is what a profile appended.
//   --exit=N        exit with N (default 0)
//   --sleep=MS      sleep before answering
//   --child         spawn a grandchild that sleeps, and print its pid to stderr
//   --bytes=N       print N bytes of 'x'
//   --print=TEXT    print TEXT
//   --print-file=F  print the contents of file F
//   --echo-argv     print the remaining argv as JSON
//   --stderr=TEXT   write TEXT to stderr
import { spawn } from 'child_process';
import { readFileSync } from 'fs';

const own = [];
const rest = [];
for (const a of process.argv.slice(2)) (a.startsWith('--') && /^--(exit|sleep|child|bytes|print|print-file|echo-argv|stderr)(=|$)/.test(a) && rest.length === 0 ? own : rest).push(a);
const opt = Object.fromEntries(own.map(a => {
  const [k, ...v] = a.slice(2).split('=');
  return [k, v.length ? v.join('=') : true];
}));

if (opt.child) {
  const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
  process.stderr.write(`grandchild ${g.pid}\n`);
}
if (opt.stderr) process.stderr.write(String(opt.stderr));
const answer = () => {
  if (opt.bytes) process.stdout.write('x'.repeat(Number(opt.bytes)));
  if (opt.print) process.stdout.write(String(opt.print));
  if (opt['print-file']) process.stdout.write(readFileSync(String(opt['print-file']), 'utf8'));
  if (opt['echo-argv']) process.stdout.write(JSON.stringify(rest));
  process.exitCode = Number(opt.exit ?? 0);
};
if (opt.sleep) setTimeout(answer, Number(opt.sleep));
else answer();
