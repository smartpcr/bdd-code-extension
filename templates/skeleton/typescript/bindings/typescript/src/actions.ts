// The {{name}} actions, TypeScript binding: one registration per action
// schema/actions.catalog.yaml declares, and its handler. Each handler reads its
// step's parameters (after substitution) from request.step, does its work, and
// returns the capture shape the catalog declares; a failure is failed(...).
// The Suite Authoring extension's *Declare action* and *Implement in
// TypeScript* add the next registration to `registrations` and its handler at
// the end of this file.
import { action, failed, type Handler, type Request } from '@bdd-suite/runtime';

/** What a handler returns. Integers are bigint, as the runtime reads them. */
type Value = Awaited<ReturnType<Handler>>;

export const registrations = [
  action('{{action}}', {{actionCamel}}),
];

async function {{actionCamel}}(request: Request): Promise<Value> {
  const text = request.step.get('text');
  if (typeof text !== 'string' || text === '') throw failed(`${request.action}: text is required`);
  return new Map<string, Value>([['text', text]]);
}
