// What the conformance corpus needs from a runtime's extension
// (conformance/README.md): the context keys its suites read, with the values
// of expressions/context.yaml, and fixture.append, which changes the list it
// is given in place (execute/capture-isolation.yml). Plain JavaScript, so all
// three frameworks load it as it is.
import { action, failed } from '@bdd-suite/runtime';

/** @type {import('@bdd-suite/runtime').Extension} */
export const corpusExtension = {
  name: 'the corpus',
  actions: [action('fixture.append', async request => {
    const list = request.step.get('list');
    if (!Array.isArray(list)) throw failed('fixture.append: list must be a list');
    list.push(request.step.get('item') ?? null);
    return list;
  })],
  contextKeys: ['cluster', 'target', 'labId', 'apiUrl'],
  start: () => ({ context: { cluster: 'HOST-CL01', target: 'HOST-N1', labId: 'lab1', apiUrl: 'http://api/api/v1' } }),
};
