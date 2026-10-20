// What the conformance corpus needs from a runtime's extension
// (conformance/README.md): the context keys its suites read, with the values
// of expressions/context.yaml, fixture.append, which changes the list it is
// given in place (execute/capture-isolation.yml), and fixture.throw, which
// throws a bare string (execute/worker-throws.yml, spec/progress.md). Plain
// JavaScript, so every framework loads it as it is.
import { action, failed } from '@bdd-suite/runtime';

/** @type {import('@bdd-suite/runtime').Extension} */
export const corpusExtension = {
  name: 'the corpus',
  actions: [action('fixture.append', async request => {
    const list = request.step.get('list');
    if (!Array.isArray(list)) throw failed('fixture.append: list must be a list');
    list.push(request.step.get('item') ?? null);
    return list;
  }), action('fixture.throw', async request => {
    throw String(request.step.get('message') ?? '');
  })],
  contextKeys: ['cluster', 'target', 'labId', 'apiUrl'],
  start: () => ({ context: { cluster: 'HOST-CL01', target: 'HOST-N1', labId: 'lab1', apiUrl: 'http://api/api/v1' } }),
};
