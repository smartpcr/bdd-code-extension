// session: oscontext
// B1.2-4 and the hover half of E-B2: hover lists the bindings an action has.
import * as assert from 'assert';
import { api, at, find, hoverText, open } from './helpers';

describe('B1.2 hover on an action', () => {
  it('B1.2-4 lifecycle.get names every binding its catalog entry lists, with links', async () => {
    const a = await api();
    const entry = a.indexers[0].index.catalog!.actions.get('lifecycle.get')!;
    const doc = await open(at('test', 'e2e', 'suites', 'lifecycle-stage0.yml'));
    const text = await hoverText(doc.uri, find(doc, 'action: lifecycle.get', 'action: '.length + 2));
    assert.match(text, /\*\*lifecycle\.get\*\* - /);
    const labels: Record<string, string> = { powershell: 'PowerShell', csharp: 'C#', go: 'Go', rust: 'Rust' };
    for (const b of entry.bindings) assert.match(text, new RegExp(`- ${labels[b].replace('#', '\\#')}: \\[[^\\]]+:\\d+\\]\\(file:`), b);
    assert.doesNotMatch(text, /not implemented/);
  });

  it('B1.2-4 / E-B2 hover half: cluster.state is PowerShell only', async () => {
    const doc = await open(at('test', 'e2e', 'suites', 'smoke.yml'));
    const text = await hoverText(doc.uri, find(doc, 'action: cluster.state', 'action: '.length + 2));
    assert.match(text, /\*\*cluster\.state\*\*/);
    assert.match(text, /- PowerShell: \[/);
    for (const other of ['C#', 'Go', 'Rust']) assert.match(text, new RegExp(`- ${other.replace('#', '\\#')}: not implemented`));
  });

});
