// One-off, kept as the record of how the corpus was imported (D2, DEC-S02):
// copies os-context's conformance corpus here, applies rename.json, hands the
// entries that test os-context's own rules over to docs/self-contained/handover,
// and prints every replacement it made.
//
//   node conformance/Import-Corpus.mjs <os-context checkout>
import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';

const source = path.join(process.argv[2] ?? '', 'test', 'e2e', 'conformance');
if (!fs.existsSync(path.join(source, 'run-manifest.yaml'))) {
  console.error('usage: node conformance/Import-Corpus.mjs <os-context checkout>');
  process.exit(2);
}
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const repo = path.resolve(here, '..');
const handover = path.join(repo, 'docs', 'self-contained', 'handover', 'conformance');
const plan = JSON.parse(fs.readFileSync(path.join(here, 'rename.json'), 'utf8'));
const handed = new Set([...plan.handedOver.entries, ...plan.handedOver.support]);
const expectationOf = suite => suite.replace(/\.yml$/, '.expected.json');

const report = [];
const rename = (text, file) => {
  for (const [from, to] of Object.entries(plan.actions)) {
    const re = new RegExp(`(?<![A-Za-z0-9_.])${from.replace('.', '\\.')}(?![A-Za-z0-9_])`, 'g');
    const count = (text.match(re) ?? []).length;
    if (count) report.push(`${file}: ${from} -> ${to} (${count})`);
    text = text.replace(re, to);
  }
  return text;
};

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
for (const file of walk(source)) {
  const rel = path.relative(source, file).split(path.sep).join('/');
  const isHanded = [...handed].some(h => rel === h || rel === expectationOf(h));
  const target = path.join(isHanded ? handover : here, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(target, isHanded ? text : rename(text, rel));
}

// The manifest without the handed-over entries and support files.
const manifestPath = path.join(here, 'run-manifest.yaml');
const doc = YAML.parseDocument(fs.readFileSync(manifestPath, 'utf8'));
const entries = doc.get('entries');
entries.items = entries.items.filter(item => !handed.has(item.get('suite')));
const support = doc.get('support');
if (support?.items) support.items = support.items.filter(item => !handed.has(String(item.value ?? item)));
fs.writeFileSync(manifestPath, doc.toString({ lineWidth: 0 }));

console.log(report.join('\n'));
console.log(`\n${report.length} files renamed; ${handed.size} entries and support files handed over to ${path.relative(repo, handover)}`);
