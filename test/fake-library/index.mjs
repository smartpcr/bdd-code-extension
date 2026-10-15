// A stand-in for the TypeScript binding's library (plan B8.1 item 5). The test
// chooses its behaviour through workerData.fake: it answers, throws, loops,
// exits, or reports another apiVersion. It reads workerData itself, so the
// real worker carries no test hook.
import { workerData } from 'node:worker_threads';

const mode = workerData?.fake ?? 'answer';

if (mode === 'load-throws') throw new Error('the library failed while loading');
if (mode === 'load-slow') await new Promise(r => setTimeout(r, 60_000));

export const apiVersion = mode === 'v2' ? '2.0.0' : mode === 'no-version' ? undefined : '1.0.0';

let invalidated = 0;

export function createLinter({ root }) {
  return {
    lint(request) {
      if (mode === 'throw') throw new Error('the library threw');
      if (mode === 'throw-string') throw 'a thrown string';
      if (mode === 'loop') for (;;);
      if (mode === 'exit') process.exit(3);
      if (mode === 'uncaught') setTimeout(() => { throw new Error('thrown later'); });
      if (mode === 'slow') {
        const until = Date.now() + (workerData.slowMs ?? 300);
        while (Date.now() < until);
      }
      return [{
        code: 'E301', severity: 'error', file: request.paths[0] ?? 'none', line: 1, column: 1,
        message: `root=${root} binding=${request.binding} overlays=${Object.keys(request.overlays).join(',')} invalidated=${invalidated}`,
      }];
    },
    invalidate() {
      invalidated++;
    },
  };
}
