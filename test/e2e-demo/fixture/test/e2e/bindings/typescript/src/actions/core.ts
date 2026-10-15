// The demo binding's actions, in TypeScript.
export interface Request {
  params: Record<string, unknown>;
}
export type Handler = (request: Request) => unknown;
export interface Registration {
  name: string;
  handler: Handler;
}

const action = (name: string, handler: Handler): Registration => ({ name, handler });

function demoGreet(request: Request): unknown {
  return { greeting: `Hello, ${String(request.params.name)}` };
}

export const coreActions: readonly Registration[] = [
  action('demo.greet', demoGreet),
];
