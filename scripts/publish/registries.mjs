// Which public registries a release publishes to (docs/packages, D16, K8):
// the repository variable PUBLIC_REGISTRIES, read by the version job. 'true'
// means all four; otherwise a comma-separated list of nuget, npm, crates and
// psgallery, so a registry whose setup is not done yet can wait without
// blocking the others; empty publishes to none. A name it does not know fails
// the run rather than skipping a registry by a typo.
//
// Writes two outputs to GITHUB_OUTPUT (or prints them):
//   registries  the publish job's matrix, a JSON array of registry names
//   verify      the clean-install job's matrix (E11): a consumer per registry
//               published to, and Go's, which the release's tag publishes
//
//   PUBLIC_REGISTRIES=nuget,npm,crates node scripts/publish/registries.mjs
import fs from 'node:fs';

const ALL = ['crates', 'npm', 'nuget', 'psgallery'];
const CONSUMERS = {
  nuget: { language: 'csharp', label: 'C#', os: 'windows-latest', script: 'samples/consumers/csharp/run-e2.ps1' },
  go: { language: 'go', label: 'Go', os: 'ubuntu-latest', script: 'samples/consumers/go/run-e3.ps1' },
  crates: { language: 'rust', label: 'Rust', os: 'ubuntu-latest', script: 'samples/consumers/rust/run-e4.ps1' },
  npm: { language: 'typescript', label: 'TypeScript', os: 'ubuntu-latest', script: 'samples/consumers/typescript/run-e5.ps1' },
  psgallery: { language: 'powershell', label: 'PowerShell', os: 'windows-latest', script: 'samples/consumers/powershell/run-e6.ps1' },
};

export function registriesOf(raw) {
  const text = (raw ?? '').trim();
  if (text === 'true') return [...ALL];
  const named = text.split(',').map(s => s.trim()).filter(Boolean);
  const unknown = named.filter(n => !ALL.includes(n));
  if (unknown.length) throw new Error(`PUBLIC_REGISTRIES names ${unknown.join(', ')}; it takes true or a list of ${ALL.join(', ')}.`);
  return ALL.filter(n => named.includes(n));
}

export function verifyOf(registries) {
  if (!registries.length) return [];
  return [...registries, 'go'].map(registry => ({ registry, ...CONSUMERS[registry] }));
}

if (process.argv[1]?.endsWith('registries.mjs')) {
  const registries = registriesOf(process.env.PUBLIC_REGISTRIES);
  const lines = `registries=${JSON.stringify(registries)}\nverify=${JSON.stringify(verifyOf(registries))}\n`;
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines);
  process.stdout.write(lines);
}
