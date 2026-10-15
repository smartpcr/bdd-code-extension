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

/** The identifier a handler expression ends with: `DemoGreet`, `actions.noop` gives `noop`; a lambda gives none. */
export function handlerIdentifier(handler: string | undefined): string | undefined {
  if (!handler || /[()=>{}]/.test(handler)) return undefined;
  return /([A-Za-z_]\w*)\s*$/.exec(handler)?.[1];
}

/**
 * Where `id` is declared as a function or method in `text`: a line that starts
 * with a declaration keyword of one of the bindings' languages (C# modifiers,
 * Go `func`, Rust `fn`, TypeScript `function`) and names `id` before `(`. Calls
 * and registration lines have no such keyword, so they never match.
 */
export function findHandlerDeclaration(text: string, id: string): { start: number; end: number } | undefined {
  const keyword = '(?:export|async|pub(?:\\([^)\\n]*\\))?|public|private|protected|internal|static|override|virtual|func|fn|function)';
  const re = new RegExp(`^[ \\t]*${keyword}\\b[^\\n=;{}]*?\\b(${id})[ \\t]*(?:<[^>\\n]*>)?[ \\t]*\\(`, 'md');
  const m = re.exec(text);
  return m?.indices?.[1] ? { start: m.indices[1][0], end: m.indices[1][1] } : undefined;
}

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
      const handler = m.groups?.handler?.trim();
      const id = handlerIdentifier(handler);
      const declared = id ? findHandlerDeclaration(text, id) : undefined;
      sites.push({
        binding, action: prefix + name, handler, file,
        range: index.range(span[0], span[1]), recognizer,
        ...(declared ? { handlerRange: index.range(declared.start, declared.end) } : {}),
      });
    }
  }
  return sites.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}
