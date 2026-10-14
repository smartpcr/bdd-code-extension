// The markdown a hover on an action shows (plan B1.2), built without vscode so
// it is unit-tested. Links are file URIs with a #L<line> fragment.
import { flattenShape } from './catalog';
import { CatalogAction, RegistrationSite } from './types';

export interface BindingLabel {
  name: string;
  label: string;
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function actionHoverMarkdown(action: CatalogAction, bindings: BindingLabel[],
  sites: RegistrationSite[], link: (site: RegistrationSite) => string): string {
  const out: string[] = [`**${action.name}** - ${action.summary}`];
  if (action.deprecated) out.push('', '*Deprecated.*');
  if (action.params.length) {
    out.push('', '| Parameter | Type | Required | Default | Description |', '| --- | --- | --- | --- | --- |');
    for (const p of action.params) {
      const def = p.default === undefined ? '' : `\`${JSON.stringify(p.default)}\``;
      out.push(`| \`${p.name}\` | ${p.type ?? ''} | ${p.required ? 'yes' : ''} | ${def} | ${cell(p.description ?? '')} |`);
    }
  }
  const shape = flattenShape(action.captures);
  out.push('', shape.length ? `Captures: ${shape.map(s => `\`${s}\``).join(', ')}` : 'Captures: nothing declared');
  if (action.captures.open && action.captures.properties.size === 0) out.push('(an open shape: paths into it are not checked)');
  if (!action.interruptible) out.push('', '`interruptible: false`: a timeout abandons the step rather than cancelling it.');
  if (action.notes) out.push('', action.notes);
  out.push('', 'Bindings:');
  for (const b of bindings) {
    if (!action.bindings.includes(b.name)) {
      out.push(`- ${b.label}: not implemented`);
      continue;
    }
    const mine = sites.filter(s => s.binding === b.name);
    out.push(mine.length
      ? `- ${b.label}: ${mine.map(s => `[${s.file.split(/[\\/]/).pop()}:${s.range.start.line + 1}](${link(s)})`).join(', ')}`
      : `- ${b.label}: implemented`);
  }
  return out.join('\n');
}
