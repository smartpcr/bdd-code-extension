// The {{name}} extension of the suite runtime: its actions, and the environment
// a guarded suite reaches. The Suite Authoring extension passes --api-url,
// --lab-id and --connection-file to every run of a guarded suite
// (bddSuite.lab.*); the generated tests read them as BDD_SUITE_OPTION_API_URL
// and so on. start hands them to every action as request.state.
import type { Extension } from '@bdd-suite/runtime';
import { registrations } from './actions.js';

export const {{prefix}}Extension: Extension = {
  name: '{{name}}',
  actions: registrations,
  options: [
    { flag: '--api-url', description: 'The environment\'s API URL.' },
    { flag: '--lab-id', description: 'The environment\'s id.' },
    { flag: '--connection-file', description: 'The environment\'s connection file.' },
  ],
  start: options => ({
    state: { apiUrl: options.get('--api-url') ?? '', labId: options.get('--lab-id') ?? '', connectionFile: options.get('--connection-file') ?? '' },
  }),
};
