// The markdown a hover on an action shows (plan B1.2), built without vscode so
// it is unit-tested. Links are file URIs with a #L<line> fragment.
import { flattenShape } from './catalog';
import { CaptureShape, CatalogAction, RegistrationSite } from './types';

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

export interface CaptureHoverSource {
  file: string;
  line: number;
  action?: string;
  fromTable: boolean;
}

/** The markdown a hover on `${capture.a.b}` shows (plan B3.4). */
export function captureHoverMarkdown(segments: string[], source: CaptureHoverSource | undefined,
  shape: CaptureShape | 'open' | undefined, link: string): string {
  const out = [`\`capture.${segments.join('.')}\``];
  if (!source) {
    out.push('', `\`${segments[0]}\` is not captured before this point (lint decides).`);
    return out.join('\n');
  }
  const where = `[${source.file.split(/[\\/]/).pop()}:${source.line + 1}](${link})`;
  out.push('', `Captured by ${source.action ? `\`${source.action}\`` : 'a step'} at ${where}`
    + (source.fromTable ? ' (a table step: a list with one entry per row)' : '') + '.');
  if (shape === 'open') out.push('', 'Open shape: paths below here are not checked.');
  else if (!shape) out.push('', `\`${segments[segments.length - 1]}\` is not in the declared capture shape.`);
  else {
    out.push('', `Type: \`${shape.type ?? 'unspecified'}\`${shape.open ? ' (open: other keys may appear)' : ''}`);
    if (shape.properties.size) out.push('', `Properties: ${[...shape.properties.keys()].map(k => `\`${k}\``).join(', ')}`);
  }
  return out.join('\n');
}
