// Registration sites found by per-language recognizers (plan B1.4, DEC-B05).
import { LineIndex, Range } from './text';
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
  const re = new RegExp(`^[ \\t]*${DECLARATION_KEYWORD}\\b[^\\n=;{}]*?\\b(${id})[ \\t]*(?:<[^>\\n]*>)?[ \\t]*\\(`, 'md');
  const m = re.exec(text);
  return m?.indices?.[1] ? { start: m.indices[1][0], end: m.indices[1][1] } : undefined;
}

/**
 * What a source file declares, for a handler registered in another file (a C#
 * registry `["a.b"] = Actions.AB,` whose method is in Actions.cs): each
 * function or method by name, at its first declaration, and the classes (or
 * structs, records, impls) it declares, which a qualified handler names.
 */
export interface SourceDeclarations {
  functions: Map<string, Range>;
  classes: Set<string>;
}

const DECLARATION_KEYWORD = '(?:export|async|pub(?:\\([^)\\n]*\\))?|public|private|protected|internal|static|override|virtual|func|fn|function)';

export function scanDeclarations(text: string): SourceDeclarations {
  const index = new LineIndex(text);
  const functions = new Map<string, Range>();
  const re = new RegExp(`^[ \\t]*${DECLARATION_KEYWORD}\\b[^\\n=;{}]*?\\b([A-Za-z_]\\w*)[ \\t]*(?:<[^>\\n]*>)?[ \\t]*\\(`, 'gmd');
  for (const m of text.matchAll(re)) {
    const [start, end] = m.indices![1];
    if (!functions.has(m[1])) functions.set(m[1], index.range(start, end));
  }
  const classes = new Set([...text.matchAll(/\b(?:class|struct|record|interface|impl)\s+([A-Za-z_]\w*)/g)].map(m => m[1]));
  return { functions, classes };
}

/** `Actions.AB` -> `Actions`, the class a qualified handler names; undefined for an unqualified one. */
export function handlerQualifier(handler: string | undefined): string | undefined {
  return handler ? /([A-Za-z_]\w*)\s*\.\s*[A-Za-z_]\w*\s*$/.exec(handler)?.[1] : undefined;
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
