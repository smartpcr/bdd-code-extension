// Registration sites found by per-language recognizers (plan B1.4, DEC-B05).
import { LineIndex } from './text';
import { RegistrationSite } from './types';

export interface CompiledRecognizer {
  re: RegExp;
  index: number;
  prefix: string;
}

export function compileRecognizers(list: { pattern: string; flags?: string; prefix?: string }[], settingPath = 'recognizers'):
  { ok: CompiledRecognizer[]; errors: string[] } {
  const ok: CompiledRecognizer[] = [];
  const errors: string[] = [];
  list.forEach((r, index) => {
    if (!r.pattern.includes('(?<name>')) {
      errors.push(`BDD040 ${settingPath}[${index}]: the pattern has no (?<name>...) group: ${r.pattern}`);
      return;
    }
    const flags = [...new Set(`gmd${r.flags ?? ''}`)].join('');
    try {
      ok.push({ re: new RegExp(r.pattern, flags), index, prefix: r.prefix ?? '' });
    } catch (e) {
      errors.push(`BDD041 ${settingPath}[${index}]: ${(e as Error).message}`);
    }
  });
  return { ok, errors };
}

const COMMENT = /^\s*(\/\/|#|--)/;

export function scanRegistrations(text: string, file: string, binding: string,
  recognizers: CompiledRecognizer[]): RegistrationSite[] {
  const index = new LineIndex(text);
  const sites: RegistrationSite[] = [];
  for (const { re, index: recognizer, prefix } of recognizers) {
    for (const m of text.matchAll(re)) {
      const span = m.indices?.groups?.name;
      const name = m.groups?.name;
      if (!span || !name) continue;
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      if (COMMENT.test(text.slice(lineStart, m.index + 1))) continue;
      sites.push({
        binding, action: prefix + name, handler: m.groups?.handler?.trim(), file,
        range: index.range(span[0], span[1]), recognizer,
      });
    }
  }
  return sites.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}
