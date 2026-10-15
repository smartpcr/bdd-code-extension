// An example extension (E3): what a workspace writes to add to the runtime
// without editing it. It uses only the package's public entry points
// (src/index.ts, published as @bdd-suite/runtime, and src/cli.ts, published as
// @bdd-suite/runtime/cli), never a module behind them.
//
// It adds one of each part of the extension API:
//   action       example.echo    returns its text, prefixed with the region
//   context key  region          ${region} in any expression
//   option       --region        where the region comes from
//   rule         a ceiling       a suite tagged slow keeps every case within 10 seconds
import { action, at, error, Extension, failed, listOf, textOf } from '../../src/index.js';

export const SLOW_CEILING_SEC = 10;

const isSlow = (suite: Parameters<typeof listOf>[0]) => (listOf(suite, 'tags') ?? []).includes('slow');

export const echo: Extension = {
  name: 'example',
  actions: [
    action('example.echo', async request => {
      const text = request.step.get('text');
      if (typeof text !== 'string') throw failed('example.echo needs a text.');
      const region = (request.state as { region: string } | undefined)?.region ?? '';
      return new Map([['echoed', `${region}:${text}`]]);
    }),
  ],
  contextKeys: ['region'],
  options: [{ flag: '--region', description: 'The region ${region} reads, and example.echo prefixes.' }],
  start: options => {
    const region = options.get('--region') ?? '';
    return { context: { region }, state: { region } };
  },
  rules: {
    // At lint: a case of a slow suite that declares more than the ceiling is E205, at the value, like the core's limits.
    lint: ({ doc, file, suite }) => {
      if (!isSlow(suite)) return [];
      return (listOf(suite, 'tests') ?? []).flatMap((c, index) => {
        const declared = c instanceof Map ? c.get('timeoutSec') : undefined;
        if (typeof declared !== 'bigint' || declared <= BigInt(SLOW_CEILING_SEC)) return [];
        return [error('E205', file, at(doc, `/tests/${index}/timeoutSec`).value,
          `Case ${textOf(c as Map<string, never>, 'name')} declares ${declared} seconds; a suite tagged slow keeps each case within ${SLOW_CEILING_SEC}.`)];
      });
    },
    // At run time: whatever a slow suite's case declares, it runs within the ceiling.
    caseLimitSec: (suite, declared) => (isSlow(suite) ? Math.min(declared, SLOW_CEILING_SEC) : declared),
  },
};
