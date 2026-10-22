// The lint worker thread (plan 2.4b items 4-7, B8.1). It loads the TypeScript
// binding's library from the workspace (INV-13), or, when the workspace has
// none, the runtime the extension carries (docs/packages, DEC-P08), and answers
// one message at a time; the library is synchronous.
import { parentPort, workerData } from 'worker_threads';
import { pathToFileURL } from 'url';
import type { HostMessage, WorkerMessage } from './protocol';

interface Linter {
  lint(request: unknown): unknown[];
  invalidate(): void;
}
interface Library {
  apiVersion?: unknown;
  createLinter?: (options: { root: string; schemaRoot?: string }) => Linter;
}

// `import()` kept as written: compiled to CommonJS it would become `require()`,
// which cannot load the library's ES module by file URL.
const load = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Library>;

const port = parentPort!;
const { libraryPath, apiMajor } = workerData as { libraryPath: string; apiMajor: number };
const post = (m: WorkerMessage) => port.postMessage(m);
const linters = new Map<string, Linter>();
let library: Library | undefined;

async function start(): Promise<void> {
  try {
    library = await load(pathToFileURL(libraryPath).href);
  } catch (e) {
    post({ type: 'refused', reason: 'load', detail: (e as Error).message });
    return;
  }
  const version = typeof library.apiVersion === 'string' ? library.apiVersion : '';
  const major = /^(\d+)\.\d+\.\d+/.exec(version)?.[1];
  if (major === undefined || Number(major) !== apiMajor || typeof library.createLinter !== 'function') {
    post({ type: 'refused', reason: 'api', detail: version || 'none', apiVersion: version });
    return;
  }
  post({ type: 'ready', apiVersion: version });
}

port.on('message', (m: HostMessage) => {
  if (m.type === 'invalidate') {
    for (const [key, linter] of linters) if (key.split('\n')[0] === m.root) linter.invalidate();
    return;
  }
  try {
    // One linter per root and schema root: a catalog outside <root>/test/e2e/schema is named (WorkspaceLayout.schemaRoot).
    const key = `${m.root}\n${m.schemaRoot ?? ''}`;
    let linter = linters.get(key);
    if (!linter) {
      linter = library!.createLinter!(m.schemaRoot ? { root: m.root, schemaRoot: m.schemaRoot } : { root: m.root });
      linters.set(key, linter);
    }
    post({ type: 'result', id: m.id, diagnostics: linter.lint(m.request) });
  } catch (e) {
    post({ type: 'error', id: m.id, detail: e instanceof Error ? e.message : String(e) });
  }
});

void start();
