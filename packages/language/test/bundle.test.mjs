// YB-1.7: the built package in a browser's global scope. The bundle is read as
// text, checked for any Node built-in or import, then evaluated as an ES module
// inside a jsdom window (no process, no require, no Buffer) and driven over an
// update2-shaped workspace: a catalog importing bdd-suite:core, a library with
// a meta step, and a suite in the style of update2's update-location.yml.
// Run by `npm run test:language` (node --experimental-vm-modules, for
// vm.SourceTextModule) after build.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const here = import.meta.dirname;
const repo = path.resolve(here, '../../..');
const bundleFile = path.join(here, '..', 'dist', 'index.js');
const bundle = readFileSync(bundleFile, 'utf8');
/** Values from the window's realm, as this realm's: deepStrictEqual compares prototypes. */
const plain = v => JSON.parse(JSON.stringify(v));

const CATALOG_FILE = '/bvt/schema/actions.catalog.yaml';
const CORE_FILE = '/bdd-suite/core.catalog.yaml';
const LIB_FILE = '/bvt/suites/_lib/urp.yml';
const SUITE_FILE = '/bvt/suites/update-location.yml';

const CATALOG = `catalogVersion: 1
bindings: [csharp]
imports:
  - bdd-suite:core
actions:
  - name: bvt.startCase
    summary: Start a correlation id for the test case.
    bindings: [csharp]
    interruptible: true
    captures:
      type: object
      additionalProperties: false
      properties:
        correlationId: { type: string }
  - name: clusterdb.clearHistory
    summary: Clear the update history the Update Service has saved.
    bindings: [csharp]
    interruptible: true
  - name: urp.getLocation
    summary: Read the stamp's update location through the REST API.
    bindings: [csharp]
    interruptible: false
    params:
      - { name: validateEnvelope, type: boolean, default: false, description: 'Also check the ARM envelope.' }
    captures:
      type: object
      additionalProperties: false
      properties:
        name: { type: string }
        state: { type: string, description: 'The overall update state.' }
        currentVersion: { type: string }
        envelopeValid: { type: boolean }
  - name: urp.waitForLocationConsistency
    summary: Read the location and the updates until their states agree.
    bindings: [csharp]
    interruptible: true
    params:
      - { name: timeoutMin, type: integer, required: true }
      - { name: pollSec, type: integer, default: 10 }
    captures:
      type: object
      additionalProperties: false
      properties:
        consistent: { type: boolean }
`;

const LIB = `metaSteps:
  - name: location-read
    description: Reads the update location, its envelope checked.
    params:
      - { name: validate, type: boolean, default: true }
    exports: [location]
    steps:
      - when: the update location is read through the REST API
        action: urp.getLocation
        validateEnvelope: \${param.validate}
        captureAs: location
`;

const SUITE = `suite: update-location
description: >-
  Checks the update location, the REST resource through which the Update Service
  reports the update status of the stamp as a whole.
imports:
  - _lib/urp.yml

beforeEach:
  - given: a new correlation id is started for this test
    why: Every Update Service event this test causes then carries the same id.
    action: bvt.startCase
    captureAs: case

afterEach:
  - then: the update history the Update Service has saved is cleared
    action: clusterdb.clearHistory

tests:
  - name: get-update-location
    tags: [bvt, fullenv, offline-safe]
    timeoutSec: 600
    steps:
      - when: the update locations are read through the REST API
        action: urp.getLocation
        validateEnvelope: true
        captureAs: location
      - then: its ARM fields are valid, it reports a current version, and its state is not Unknown
        action: core.noop
        asserts:
          - var: location.envelopeValid
            isTrue: true
          - var: location.state
            notEquals: Unknown

  - name: location-state-consistent-with-updates
    tags: [bvt, fullenv, offline-safe]
    timeoutSec: 600
    steps:
      - when: the location and the updates are read until their states agree or two minutes pass
        action: urp.waitForLocationConsistency
        timeoutMin: 2
        pollSec: 10
        captureAs: snapshot
      - then: the location's state agrees with the updates' states
        action: core.noop
        asserts:
          - var: snapshot.consistent
            isTrue: true

  - name: location-through-the-library
    tags: [bvt]
    steps:
      - meta: location-read
        with:
          validate: true
      - then: the version it reports is kept
        action: core.set
        value: \${capture.location.currentVersion}
        captureAs: version
`;
const LINES = SUITE.split('\n');
/** The position of `text` on the first line holding `marker`. */
const at = (marker, text = marker) => {
  const line = LINES.findIndex(l => l.includes(marker));
  assert.ok(line >= 0, `no line has ${marker}`);
  return { line, character: LINES[line].indexOf(text) };
};

test('the bundle names no Node built-in and imports nothing', () => {
  // Each pattern with a line it must catch. A require inside a string is not a call: ajv's generated
  // code names its runtime as 'require("ajv/dist/runtime/equal").default', and that text is in the bundle.
  const forbidden = [
    [/["'`]node:[a-z_/]+["'`]/, 'import { join } from "node:path";'],
    [/(?<!['"`\w.$])require\s*\(\s*["'`]/, 'var fs = require("fs");'],
    [/^\s*import\s*(?:[\w*{][^;]*?from\s*)?["'`]/m, "import * as path from 'path';"],
    [/\bimport\s*\(\s*["'`]/, "await import('os');"],
  ];
  for (const [re, sample] of forbidden) {
    assert.match(sample, re);
    assert.doesNotMatch(bundle, re);
  }
  assert.doesNotMatch(`x.code = 'require("ajv/dist/runtime/equal").default';`, forbidden[1][0]);
  assert.match(bundle, /^export \{/m, 'an ES module');
});

const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://dashboard.invalid/' });
const context = dom.getInternalVMContext();
const lang = await (async () => {
  const mod = new vm.SourceTextModule(bundle, { context, identifier: pathToFileURL(bundleFile).href });
  await mod.link(specifier => { throw new Error(`the bundle imports ${specifier}`); });
  await mod.evaluate();
  return mod.namespace;
})();

test('the window is a browser scope: no process, require or Buffer', () => {
  assert.deepEqual(plain(vm.runInContext('[typeof process, typeof require, typeof Buffer, typeof document]', context)),
    ['undefined', 'undefined', 'undefined', 'object']);
});

test('the package carries its version and the core catalog of that version', () => {
  const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
  assert.equal(lang.VERSION, pkg.version);
  assert.equal(lang.CORE_CATALOG_TEXT, readFileSync(path.join(repo, 'spec', 'core.catalog.yaml'), 'utf8').replace(/\r\n/g, '\n'));
  assert.equal(lang.CORE_IMPORT, 'bdd-suite:core');
});

const read = file => ({ [CORE_FILE]: lang.CORE_CATALOG_TEXT, [CATALOG_FILE]: CATALOG }[file]);
const catalog = lang.resolveCatalog(CATALOG, CATALOG_FILE, read, CORE_FILE);
const suite = lang.parseSuite(SUITE, SUITE_FILE);
const lib = lang.parseSuite(LIB, LIB_FILE);
const index = new lang.WorkspaceIndex();
index.updateCatalog(catalog);
index.updateSuite(suite);
index.updateSuite(lib);

test('parseSuite: the suite, its cases and steps with positions, its import resolved by POSIX rules', () => {
  assert.equal(suite.suiteName, 'update-location');
  assert.equal(suite.parseError, undefined);
  assert.deepEqual(plain(suite.cases.map(c => c.name)),
    ['get-update-location', 'location-state-consistent-with-updates', 'location-through-the-library']);
  assert.deepEqual(plain(suite.imports.map(i => i.resolved)), [LIB_FILE]);
  const get = suite.steps.find(s => s.action === 'urp.getLocation');
  assert.deepEqual(plain(get.actionRange.start), at('action: urp.getLocation', 'urp.getLocation'));
  assert.equal(get.captureAs, 'location');
  assert.deepEqual(plain(get.home), { kind: 'case', caseName: 'get-update-location', caseIndex: 0 });
  assert.deepEqual(plain(get.params.map(p => [p.name, p.value])), [['validateEnvelope', true]]);
  assert.equal(suite.steps.find(s => s.action === 'bvt.startCase').home.hook, 'beforeEach');
  assert.deepEqual(plain(suite.steps.find(s => s.action === 'core.set').expressions.map(e => e.text)), ['${capture.location.currentVersion}']);
  assert.deepEqual(plain(lib.metaSteps.map(m => [m.name, m.params, m.exports])), [['location-read', ['validate'], ['location']]]);
  assert.deepEqual(plain(lang.findExpressions('a ${x} b')), [[2, 6]]);
});

test('resolveCatalog: bdd-suite:core read through the callback, cut to the catalog\'s bindings', () => {
  assert.deepEqual(plain(catalog.errors), []);
  assert.deepEqual(plain(catalog.imports), [CORE_FILE]);
  const noop = catalog.actions.get('core.noop');
  assert.equal(noop.file, CORE_FILE);
  assert.deepEqual(plain(noop.bindings), ['csharp']);
  assert.ok(catalog.actions.has('wait'), 'the core catalog\'s wait');
  const location = catalog.actions.get('urp.getLocation');
  assert.equal(location.file, undefined, 'the workspace catalog\'s own');
  assert.deepEqual(plain(lang.flattenShape(location.captures)),
    ['name: string', 'state: string', 'currentVersion: string', 'envelopeValid: boolean']);
  assert.equal(lang.parseCatalog('catalogVersion: 1\nactions: [', CATALOG_FILE).errors[0].code, 'BDD022');
});

test('the index: meta steps to their definition, actions to their catalog entry and registration', () => {
  const metaStep = suite.steps.find(s => s.meta === 'location-read');
  const target = index.metaTargetOf(metaStep);
  assert.equal(target.file, LIB_FILE);
  assert.deepEqual(plain(target.def.nameRange.start), { line: 1, character: 10 });
  assert.deepEqual(plain(index.metaUses(target).map(s => s.file)), [SUITE_FILE]);
  assert.deepEqual(plain([...index.visibleMetaSteps(SUITE_FILE).keys()]), ['location-read']);
  const pos = at('action: urp.getLocation', 'getLocation');
  assert.equal(index.actionNameAt(SUITE_FILE, pos), 'urp.getLocation');
  assert.equal(index.stepAt(SUITE_FILE, pos).captureAs, 'location');
  assert.deepEqual(plain(index.stepsUsing('urp.getLocation').map(s => s.file).sort()), [LIB_FILE, SUITE_FILE]);
  assert.equal(index.catalog.actions.get('urp.getLocation').nameRange.start.line, CATALOG.split('\n').findIndex(l => l.includes('urp.getLocation')));
  // A C# binding's registry, found by a recognizer as the extension's defaults do.
  const { ok } = lang.compileRecognizers([{ pattern: '\\["(?<name>[\\w.]+)"\\]\\s*=\\s*(?<handler>[\\w.]+)' }]);
  const source = 'class UrpExtension {\n  handlers = {\n    ["urp.getLocation"] = UrpActions.GetLocation,\n  };\n}\n';
  const sites = lang.scanRegistrations(source, '/bvt/bindings/UrpExtension.cs', 'csharp', ok);
  index.updateSources('/bvt/bindings/UrpExtension.cs', sites);
  assert.deepEqual(plain(index.sitesFor('urp.getLocation').map(s => [s.handler, s.range.start])),
    [['UrpActions.GetLocation', { line: 2, character: 6 }]]);
});

test('scope and shapes: captures in scope at an assertion, fields by the declared shape', () => {
  const pos = at('var: location.state', 'location');
  const scope = lang.scopeAt(index, SUITE_FILE, pos);
  assert.deepEqual([...scope.captures.keys()].sort(), ['case', 'location']);
  assert.deepEqual(plain(lang.subjectStatus(index, SUITE_FILE, pos, ['location', 'state'])), ['known', 'known']);
  assert.deepEqual(plain(lang.subjectStatus(index, SUITE_FILE, pos, ['location', 'status'])), ['known', 'unknown']);
  assert.deepEqual(plain(lang.subjectStatus(index, SUITE_FILE, pos, ['snapshot'])), ['unknown'], 'another case\'s capture');
  const shape = lang.shapeAt(catalog.actions.get('urp.getLocation'), ['state'], false);
  assert.equal(shape.type, 'string');
  // Through the library's meta step: its export is in scope in the case that uses it.
  const later = lang.scopeAt(index, SUITE_FILE, at('value: ${capture', 'capture'));
  assert.equal(later.captures.get('location').step.file, LIB_FILE);
  assert.deepEqual(plain(lang.capturePathAt('capture.location.currentVersion', 12)), ['location', 'currentVersion']);
});

test('completion contexts and the required-parameter snippet', () => {
  assert.equal(lang.actionPrefix('        action: urp.wait'), 'urp.wait');
  const action = catalog.actions.get('urp.waitForLocationConsistency');
  const required = action.params.filter(p => p.required).map(p => p.name);
  assert.equal(lang.requiredParamsSnippet(action.name, required, 8, new Set()), 'urp.waitForLocationConsistency\n        timeoutMin: $1');
  assert.equal(lang.requiredParamsSnippet(action.name, required, 8, new Set(['timeoutMin'])), 'urp.waitForLocationConsistency');
  const subject = at('var: location.state');
  assert.deepEqual(plain(lang.assertSubjectPrefix(LINES, subject.line, LINES[subject.line].indexOf('.state') + 4)),
    { segments: ['location'], prefix: 'sta', start: LINES[subject.line].indexOf('state') });
  const validate = at('validate: true');
  assert.equal(lang.withKeyPrefix(LINES, validate.line, LINES[validate.line].indexOf('validate') + 3), 'val');
  assert.equal(lang.metaPrefix('      - meta: loc'), 'loc');
  assert.deepEqual(plain(lang.keyPrefix('        poll')), { column: 8, typed: 'poll' });
  // The keys the step whose action is on a line already has: what the snippet leaves out.
  const around = lang.stepKeysAround(LINES, at('action: urp.waitForLocationConsistency').line);
  assert.equal(around.keyColumn, 8);
  assert.deepEqual([...around.keys].sort(), ['action', 'captureAs', 'pollSec', 'timeoutMin', 'when']);
});

test('the expression cursor inside ${ }', () => {
  const text = 'value: ${capture.location.cur';
  assert.deepEqual(plain(lang.cursorContext(text, text.length)),
    { kind: 'path', root: 'capture', segments: ['location'], prefix: 'cur', start: text.length - 3 });
  const root = 'value: ${lo';
  assert.deepEqual(plain(lang.cursorContext(root, root.length)), { kind: 'root', prefix: 'lo', start: root.length - 2 });
  assert.equal(lang.cursorContext('value: plain', 5), undefined);
  assert.equal(lang.enclosingExpression(text, text.length), text.indexOf('${') + 2);
  assert.equal(lang.FUNCTIONS.lower, 'lower(text)');
  assert.deepEqual(plain(lang.NAMESPACES), ['capture', 'param', 'var', 'row']);
  assert.ok(lang.CONTEXT_KEYS.includes('timeoutSec'));
});

test('hover text for an action and for a capture path', () => {
  const action = catalog.actions.get('urp.getLocation');
  const md = lang.actionHoverMarkdown(action, [{ name: 'csharp', label: 'C#' }], index.sitesFor(action.name), s => `file://${s.file}#L${s.range.start.line + 1}`);
  const lines = md.split('\n');
  assert.equal(lines[0], '**urp.getLocation** - Read the stamp\'s update location through the REST API.');
  assert.ok(lines.includes('| `validateEnvelope` | boolean |  | `false` | Also check the ARM envelope. |'), md);
  assert.ok(lines.includes('- C#: [UrpExtension.cs:3](file:///bvt/bindings/UrpExtension.cs#L3)'), md);
  assert.ok(lines.includes('`interruptible: false`: a timeout abandons the step rather than cancelling it.'), md);
  const shape = lang.shapeAt(action, ['state'], false);
  const capture = lang.captureHoverMarkdown(['location', 'state'], { file: SUITE_FILE, line: 23, action: action.name, fromTable: false }, shape, 'L24');
  assert.equal(capture, '`capture.location.state`\n\nCaptured by `urp.getLocation` at [update-location.yml:24](L24).\n\nType: `string`');
});

test('the schema check against suite.schema.json, at the key or value concerned', () => {
  const schema = vm.runInContext('JSON.parse', context)(readFileSync(path.join(repo, 'spec', 'suite.schema.json'), 'utf8'));
  const compiled = lang.compileSuiteSchema(schema);
  assert.equal(compiled.error, undefined);
  // spec/suite.schema.json is the core's alone: a workspace's generated schema adds its actions, so here
  // each update2 action is refused at its value, and core.noop and core.set are accepted.
  const core = plain(lang.checkAgainstSchema(SUITE, compiled.validate));
  const own = ['bvt.startCase', 'clusterdb.clearHistory', 'urp.getLocation', 'urp.waitForLocationConsistency'];
  assert.deepEqual(core.map(f => f.range.start), own.map(a => at(`action: ${a}`, a)));
  assert.ok(core.every(f => f.message.startsWith('Value is not accepted. Valid values: core.noop, core.set,')), JSON.stringify(core));
  const broken = SUITE.replace('timeoutSec: 600', 'timeoutSec: soon').replace('tags: [bvt]\n', 'tags: [bvt]\n    owner: me\n');
  const findings = plain(lang.checkAgainstSchema(broken, compiled.validate));
  assert.equal(findings.length, core.length + 2, JSON.stringify(findings));
  const brokenLines = broken.split('\n');
  const soon = brokenLines.findIndex(l => l.includes('timeoutSec: soon'));
  const owner = brokenLines.findIndex(l => l.includes('owner: me'));
  assert.ok(findings.some(f => f.range.start.line === soon && f.message.startsWith('/tests/0/timeoutSec must match pattern')), JSON.stringify(findings));
  assert.ok(findings.some(f => f.range.start.line === owner && f.message === 'Property "owner" is not allowed here.'), JSON.stringify(findings));
  assert.equal(lang.librarySchema(schema).required.includes('suite'), false);
  // A library is held to the same shapes without the root's required suite and tests: only its action is refused.
  const library = plain(lang.checkAgainstSchema(LIB, lang.compileSuiteSchema(lang.librarySchema(schema)).validate));
  assert.deepEqual(library.map(f => f.range.start), [{ line: LIB.split('\n').findIndex(l => l.includes('urp.getLocation')), character: 16 }]);
  assert.equal(plain(lang.checkAgainstSchema(LIB, compiled.validate)).filter(f => f.message.startsWith('Missing required property')).length, 2);
});

test('semantic tokens: actions by where they are implemented, parameters, meta steps and capture fields', () => {
  const ctx = {
    action: name => {
      const a = catalog.actions.get(name);
      return a ? { status: a.bindings.includes('csharp') ? 'implemented' : 'notInTarget', params: a.params.map(p => ({ name: p.name, required: !!p.required })) }
        : { status: 'undeclared' };
    },
    meta: name => {
      const t = index.visibleMetaSteps(SUITE_FILE).get(name);
      return t && t.def.params.map(p => ({ name: p, required: t.def.required.includes(p) }));
    },
    envelope: new Set(['given', 'when', 'then', 'and', 'why', 'action', 'meta', 'with', 'captureAs', 'asserts', 'timeoutSec']),
    subject: (pos, segments) => lang.subjectStatus(index, SUITE_FILE, pos, segments),
  };
  const text = SUITE.replace('action: clusterdb.clearHistory', 'action: clusterdb.clearAll');
  const tokens = plain(lang.suiteTokens(text, ctx));
  const textLines = text.split('\n');
  const tokenAt = (marker, word) => {
    const line = textLines.findIndex(l => l.includes(marker));
    return tokens.find(t => t.line === line && t.character === textLines[line].indexOf(word));
  };
  assert.deepEqual(tokenAt('action: urp.getLocation', 'urp.getLocation'),
    { line: at('action: urp.getLocation').line, character: 16, length: 15, type: 'action', modifiers: ['implemented'] });
  assert.deepEqual(tokenAt('action: clusterdb.clearAll', 'clusterdb.clearAll').modifiers, ['undeclared']);
  assert.equal(tokenAt('timeoutMin: 2', 'timeoutMin').type, 'parameter');
  assert.deepEqual(tokenAt('timeoutMin: 2', 'timeoutMin').modifiers, ['required']);
  assert.equal(tokenAt('meta: location-read', 'location-read').type, 'metaStep');
  assert.deepEqual(tokenAt('captureAs: location', 'location').modifiers, ['declaration']);
  assert.equal(tokenAt('var: location.state', 'state').type, 'field');
  assert.equal(tokenAt('var: location.state', 'location').type, 'variable');
  assert.ok(lang.TOKEN_TYPES.includes('metaStep') && lang.TOKEN_MODIFIERS.includes('undeclared'));
});

test('positions and keys: LineIndex and fileKey as the extension uses them', () => {
  const li = new lang.LineIndex('a\nbc\n');
  assert.deepEqual(plain(li.range(2, 4)), { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } });
  assert.equal(lang.fileKey('/bvt/suites/./_lib/../update-location.yml'), SUITE_FILE);
  assert.equal(lang.fileKey('C:\\BVT\\a.yml'), 'c:\\BVT\\a.yml');
  assert.equal(lang.contains({ start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, { line: 1, character: 5 }), true);
});
