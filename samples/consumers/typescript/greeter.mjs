// The greeter's extension: what a consumer writes to add its own actions to the
// runtime. Its suiterun and its generated tests both load it.
import { action } from '@bdd-suite/runtime';

const greeting = text => new Map([['text', text]]);

/** @type {import('@bdd-suite/runtime').Extension} */
export const greeterExtension = {
  name: 'greeter',
  actions: [
    action('greet.say', async request => greeting(`Hello, ${request.step.get('name')}!`)),
    action('greet.shout', async request => greeting(`HELLO, ${String(request.step.get('name')).toUpperCase()}!`)),
  ],
};
