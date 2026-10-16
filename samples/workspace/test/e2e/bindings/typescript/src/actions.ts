// The shop's actions, TypeScript binding. Every handler is small and
// deterministic, and returns what the other four bindings return for the same
// step, so one suite gives one result everywhere.
import { action, failed, type Handler, type Request } from '@bdd-suite/runtime';

/** What a handler returns. Integers are bigint, as the runtime reads them. */
type Value = Awaited<ReturnType<Handler>>;

const object = (entries: Record<string, Value>): Value => new Map(Object.entries(entries));

/** A parameter as text, or undefined when it is absent or empty. */
function given(request: Request, name: string): string | undefined {
  const value = request.step.get(name);
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : String(value);
  return text === '' ? undefined : text;
}

/** A required text parameter. */
function text(request: Request, name: string): string {
  const value = given(request, name);
  if (value === undefined) throw failed(`${request.action} needs a ${name}.`);
  return value;
}

/** An integer parameter, given as a number or as a numeric string. */
function integer(request: Request, name: string, fallback: bigint): bigint {
  const value = request.step.get(name);
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  const raw = String(value).trim();
  if (!/^[+-]?\d+$/.test(raw)) throw failed(`${request.action}: ${name} is not a whole number.`);
  return BigInt(raw);
}

async function inventoryGet(request: Request): Promise<Value> {
  const sku = text(request, 'sku');
  return object({ sku, quantity: BigInt(sku.length * 10), inStock: true });
}

async function cartAdd(request: Request): Promise<Value> {
  const sku = text(request, 'sku');
  const quantity = integer(request, 'quantity', 1n);
  return object({ sku, quantity, line: `${sku}x${quantity}` });
}

async function orderPlace(request: Request): Promise<Value> {
  const sku = text(request, 'sku');
  const quantity = integer(request, 'quantity', 1n);
  return object({ orderId: `ORD-${sku}-${quantity}`, status: 'placed' });
}

async function stockReserve(request: Request): Promise<Value> {
  const sku = text(request, 'sku');
  return object({ sku, reserved: integer(request, 'quantity', 1n) });
}

async function shippingQuote(request: Request): Promise<Value> {
  const weight = integer(request, 'weightKg', 0n);
  if (weight <= 0n) throw failed('shipping.quote needs a weightKg above zero.');
  const policy = given(request, 'policy') ?? 'Standard';
  const rates: Record<string, bigint> = { Standard: 5n, Express: 10n };
  const rate = rates[policy];
  if (rate === undefined) throw failed(`shipping.quote: unknown policy ${policy}.`);
  return object({ policy, cost: weight * rate });
}

async function customerLookup(request: Request): Promise<Value> {
  const id = text(request, 'id');
  return object({ id, name: `Customer ${id}`, tier: id.startsWith('G') ? 'gold' : 'standard' });
}

async function auditLog(request: Request): Promise<Value> {
  text(request, 'message');
  return object({ logged: true });
}

/** Every action this binding implements. */
export const registrations = [
  action('inventory.get', inventoryGet),
  action('cart.add', cartAdd),
  action('order.place', orderPlace),
  action('stock.reserve', stockReserve),
  action('shipping.quote', shippingQuote),
  action('customer.lookup', customerLookup),
  action('audit.log', auditLog),
];
