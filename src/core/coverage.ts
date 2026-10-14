// Binding support per action: the inlay badge and its tooltip (plan B2.3).

export interface BadgeBinding {
  name: string;
  abbreviation?: string;
  label?: string;
}

/**
 * The abbreviations of the bindings that implement an action, in the catalog's
 * top-level order, then any binding the catalog does not list.
 */
export function renderBindingBadge(order: string[], actionBindings: string[], known: BadgeBinding[]): string {
  const rank = (b: string) => (order.includes(b) ? order.indexOf(b) : order.length);
  return [...actionBindings].sort((a, b) => rank(a) - rank(b))
    .map(b => known.find(k => k.name === b)?.abbreviation || b).join(' ');
}

export function bindingTooltip(actionBindings: string[], known: BadgeBinding[], target: string): string {
  const label = (b: string) => known.find(k => k.name === b)?.label || b;
  const lines = [`Implemented by: ${actionBindings.length ? actionBindings.map(label).join(', ') : 'no binding'}`];
  if (!actionBindings.includes(target)) lines.push(`Not implemented by ${label(target)}`);
  return lines.join('\n');
}
