// The demo workspace's actions: its extension of the TypeScript runtime.
import { action, failed, type Registration, type Request } from '@bdd-suite/runtime';

export const registrations: readonly Registration[] = [
  action('demo.greet', demoGreet),
];

async function demoGreet(request: Request) {
  const name = request.step.get('name');
  if (typeof name !== 'string') throw failed('demo.greet needs a name.');
  return new Map([['greeting', `Hello, ${name}`]]);
}
