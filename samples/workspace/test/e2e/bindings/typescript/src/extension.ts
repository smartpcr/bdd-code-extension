// The sample workspace's extension, TypeScript binding: its shop actions, the
// context key store and the option --store that sets it.
import type { Extension } from '@bdd-suite/runtime';
import { registrations } from './actions.js';

export const shop: Extension = {
  name: 'shop',
  actions: registrations,
  contextKeys: ['store'],
  options: [{ flag: '--store', description: 'The store ${store} reads (main by default).' }],
  start: options => {
    const store = options.get('--store') || 'main';
    return { context: { store }, state: { store } };
  },
};
