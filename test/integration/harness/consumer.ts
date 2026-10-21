// The scratch workspace of E9 (docs/packages): the C# consumer sample alone, in
// the layout the extension's defaults look for (test/e2e/schema beside
// test/e2e/suites), with no TypeScript binding, no spec copy and no settings.
// Its catalog imports bdd-suite:core; its Directory.Packages.props pins the
// packages at this checkout's version.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { repo } from './sample';

export function createConsumerWorkspace(): string {
  const from = path.join(repo, 'samples', 'consumers', 'csharp');
  const to = fs.mkdtempSync(path.join(os.tmpdir(), 'bdd-suite-consumer-'));
  const copy = (src: string, dest: string) => {
    fs.mkdirSync(path.dirname(path.join(to, dest)), { recursive: true });
    fs.copyFileSync(path.join(from, src), path.join(to, dest));
  };
  for (const f of ['actions.catalog.yaml', 'suite.schema.json', 'suite.schema.md']) copy(`schema/${f}`, `test/e2e/schema/${f}`);
  for (const f of fs.readdirSync(path.join(from, 'suites'))) copy(`suites/${f}`, `test/e2e/suites/${f}`);
  copy('Directory.Packages.props', 'Directory.Packages.props');
  return to;
}

export function removeConsumerWorkspace(folder: string): void {
  fs.rmSync(folder, { recursive: true, force: true });
}
