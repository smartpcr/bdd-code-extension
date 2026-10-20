// A node:test reporter writing JUnit XML that keeps suite-level failures
// (docs/test-providers, DEC-T05): node's own JUnit reporter drops a failure in
// a describe's after hook, which is where a suite teardown fails (T0). Each
// test is a <testcase> whose classname is its describes joined by " > "; a
// describe that failed for itself, not because a test in it did, is one more
// <testcase> named after the describe, as Vitest's JUnit reporter writes it.
//
//   node --test --test-reporter=@bdd-suite/runtime/testing/node-reporter --test-reporter-destination=junit.xml
interface TestEvent {
  type: string;
  data: {
    name: string;
    nesting: number;
    file?: string;
    skip?: boolean | string;
    todo?: boolean | string;
    details?: { type?: string; duration_ms?: number; error?: Error & { failureType?: string; cause?: unknown } };
  };
}

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The message a failure carries: the error the test or hook threw, not node's wrapper around it. */
function messageOf(error: (Error & { cause?: unknown }) | undefined): string {
  const cause = error?.cause;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return error?.message ?? 'failed';
}

/** The reporter: node:test passes its events, and the XML is what it writes. */
export default async function* junit(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  // The names of the tests around the current one, by nesting, one stack per
  // test file: node interleaves the events of files that run at the same time
  // (seen on Linux CI), and every event names its file, a generated
  // describe's too, because the generated file calls describe itself.
  const stacks = new Map<string, string[]>();
  const stackOf = (file: string | undefined): string[] => {
    const key = file ?? '';
    let stack = stacks.get(key);
    if (!stack) stacks.set(key, (stack = []));
    return stack;
  };
  const cases: string[] = [];
  let failures = 0;
  let skipped = 0;
  for await (const event of source) {
    const { data } = event;
    const stack = stackOf(data.file);
    // test:dequeue comes for every test and describe, skipped or not; test:start not for a describe whose tests all skip.
    if (event.type === 'test:dequeue' || event.type === 'test:start') {
      stack.length = data.nesting;
      stack.push(data.name);
      continue;
    }
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const suiteLevel = data.details?.type === 'suite';
    const error = data.details?.error;
    // A describe passes or fails with its tests; only a failure of its own (a hook) is reported.
    if (suiteLevel && (event.type === 'test:pass' || error?.failureType === 'subtestsFailed')) continue;
    const classname = stack.slice(0, data.nesting).join(' > ');
    const time = ((data.details?.duration_ms ?? 0) / 1000).toFixed(3);
    let body = '';
    if (event.type === 'test:fail') {
      failures++;
      body = `<failure message="${xml(messageOf(error))}" type="${xml(error?.failureType ?? 'testCodeFailure')}"/>`;
    } else if (data.skip !== undefined && data.skip !== false) {
      skipped++;
      body = `<skipped message="${xml(typeof data.skip === 'string' ? data.skip : '')}"/>`;
    }
    cases.push(`  <testcase name="${xml(data.name)}" classname="${xml(classname)}" time="${time}"${body ? `>${body}</testcase>` : '/>'}`);
  }
  yield `<?xml version="1.0" encoding="utf-8"?>\n<testsuites tests="${cases.length}" failures="${failures}" skipped="${skipped}">\n${cases.join('\n')}${cases.length ? '\n' : ''}</testsuites>\n`;
}
