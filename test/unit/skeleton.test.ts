// Suite: Create suites workspace skeleton: the names one name gives, template
// overlay, and the plan from the shipped templates/skeleton for each language
// and both, checked for what the extension and the bindings then read.
import * as assert from 'assert';
import * as fs from 'fs';
import { test } from 'node:test';
import * as path from 'path';
import * as YAML from 'yaml';
import { parseCatalog } from '../../src/core/catalog';
import { csharpHandlerClass, powershellStubFile } from '../../src/core/stubs';
import {
  isSkeletonLanguage, overlayTemplates, planSkeleton, SKELETON_LANGUAGES, SkeletonLanguage, SkeletonPlan, skeletonNameProblem, skeletonNames,
  skeletonParts, suggestSkeletonName, TemplateFile,
} from '../../src/core/skeleton';

const shipped = path.resolve(__dirname, '../../../templates/skeleton');

function readDir(dir: string, under = ''): TemplateFile[] {
  return fs.readdirSync(path.join(dir, under), { withFileTypes: true }).flatMap(e => {
    const rel = under ? `${under}/${e.name}` : e.name;
    return e.isDirectory() ? readDir(dir, rel) : [{ path: rel, text: fs.readFileSync(path.join(dir, rel), 'utf8').replace(/\r\n/g, '\n') }];
  });
}

const templates = (part: string) => readDir(path.join(shipped, part));

/** The settings files' JSONC: comments on lines of their own. */
const parseJsonc = (text: string): unknown => JSON.parse(text.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n'));

function plan(languages: SkeletonLanguage[], name = 'order-service'): SkeletonPlan {
  const p = planSkeleton({ name, languages, version: '9.8.7', templates });
  assert.ok(!('refused' in p), 'refused' in p ? p.refused : '');
  return p;
}

const file = (p: SkeletonPlan, at: string) => {
  const f = p.files.find(x => x.path === at);
  assert.ok(f, `${at} is planned; planned: ${p.files.map(x => x.path).join(', ')}`);
  return f.text;
};

test('one name gives the suite, the namespace, the action family and the first action', () => {
  assert.deepStrictEqual(skeletonNames('order-service'),
    { name: 'order-service', namespace: 'OrderService', prefix: 'orderService', action: 'orderService.echo', actionName: 'OrderServiceEcho' });
  assert.deepStrictEqual(skeletonNames('shop2'), { name: 'shop2', namespace: 'Shop2', prefix: 'shop2', action: 'shop2.echo', actionName: 'Shop2Echo' });
  assert.strictEqual(skeletonNameProblem('order-service'), undefined);
  for (const bad of ['', 'Orders', '2shop', 'order--service', 'order-', 'order_service', 'order service']) {
    assert.match(skeletonNameProblem(bad) ?? '', /lower-case letters and digits/, bad);
  }
});

test('a name suggested from a folder name', () => {
  assert.strictEqual(suggestSkeletonName('My Orders_v2'), 'my-orders-v2');
  assert.strictEqual(suggestSkeletonName('2024 shop'), 'shop');
  assert.strictEqual(suggestSkeletonName('42'), undefined);
  assert.strictEqual(suggestSkeletonName('---'), undefined);
});

test('the languages a skeleton has, in picker order', () => {
  assert.deepStrictEqual(SKELETON_LANGUAGES.map(l => [l.id, l.label]), [['csharp', 'C#'], ['powershell', 'PowerShell']]);
  assert.ok(isSkeletonLanguage('powershell'));
  assert.ok(!isSkeletonLanguage('go'));
  assert.ok(!isSkeletonLanguage('toString'));
  assert.deepStrictEqual(skeletonParts(['powershell', 'csharp']), ['common', 'powershell', 'csharp']);
});

test('a workspace\'s own templates replace the shipped ones by path and add new ones', () => {
  const out = overlayTemplates([{ path: 'a', text: '1' }, { path: 'b', text: '2' }], [{ path: 'b', text: 'own' }, { path: 'c', text: '3' }]);
  assert.deepStrictEqual(out, [{ path: 'a', text: '1' }, { path: 'b', text: 'own' }, { path: 'c', text: '3' }]);
});

test('a plan is refused for a bad name, no language, a repeated language or a part with no templates', () => {
  const refusal = (r: ReturnType<typeof planSkeleton>) => ('refused' in r ? r.refused : '');
  assert.match(refusal(planSkeleton({ name: 'Bad', languages: ['csharp'], version: '1.0.0', templates })), /lower-case/);
  assert.match(refusal(planSkeleton({ name: 'ok', languages: [], version: '1.0.0', templates })), /at least one language/);
  assert.match(refusal(planSkeleton({ name: 'ok', languages: ['csharp', 'csharp'], version: '1.0.0', templates })), /twice/);
  assert.match(refusal(planSkeleton({ name: 'ok', languages: ['csharp'], version: '1.0.0', templates: p => (p === 'csharp' ? [] : templates(p)) })),
    /no templates for csharp/);
});

test('paths: __key__ takes its value, dot. is a dot-file, and an unknown key is left as it is', () => {
  const p = planSkeleton({
    name: 'shop', languages: ['csharp'], version: '1.0.0',
    templates: part => (part === 'common'
      ? [{ path: 'dot.vscode/__Namespace__.txt', text: '{{name}} {{unknown}}' }, { path: '__nope__/x', text: '' }]
      : [{ path: 'dot.vscode/__Namespace__.txt', text: 'more' }]),
  });
  assert.ok(!('refused' in p));
  assert.deepStrictEqual(p.files, [{ path: '__nope__/x', text: '' }, { path: '.vscode/Shop.txt', text: 'shop {{unknown}}\n\nmore' }]);
});

test('every planned file is filled in: no {{key}} or __key__ is left', () => {
  for (const languages of [['csharp'], ['powershell'], ['csharp', 'powershell']] as SkeletonLanguage[][]) {
    for (const f of plan(languages).files) {
      assert.doesNotMatch(f.text, /\{\{\w+\}\}/, `${languages}: ${f.path}`);
      assert.doesNotMatch(f.path, /__\w+__|(^|\/)dot\./, `${languages}: ${f.path}`);
    }
  }
});

test('C#: the files a C# workspace needs, its settings, and a catalog its bindingSources and the stub planner agree with', () => {
  const p = plan(['csharp']);
  const paths = p.files.map(f => f.path).sort();
  assert.deepStrictEqual(paths, [
    '.gitignore', '.vscode/extensions.json', '.vscode/settings.json', 'README.md',
    'bindings/dotnet/Directory.Build.props', 'bindings/dotnet/Directory.Packages.props',
    'bindings/dotnet/OrderService.Suite.Cli/OrderService.Suite.Cli.csproj', 'bindings/dotnet/OrderService.Suite.Cli/Program.cs',
    'bindings/dotnet/OrderService.Suite.MsTest/OrderService.Suite.MsTest.csproj', 'bindings/dotnet/OrderService.Suite.MsTest/bddsuite.tests.yaml',
    'bindings/dotnet/OrderService.Suite.MsTest/tests.runsettings', 'bindings/dotnet/OrderService.Suite.slnx',
    'bindings/dotnet/OrderService.Suite/OrderService.Suite.csproj', 'bindings/dotnet/OrderService.Suite/OrderServiceActions.cs',
    'bindings/dotnet/OrderService.Suite/OrderServiceExtension.cs',
    'nuget.config', 'schema/actions.catalog.yaml', 'suites/order-service.yml',
  ]);
  const settings = parseJsonc(file(p, '.vscode/settings.json')) as Record<string, unknown>;
  assert.strictEqual(settings['bddSuite.catalogPath'], 'schema/actions.catalog.yaml');
  assert.strictEqual(settings['bddSuite.lintTool'], 'csharp');
  assert.strictEqual(settings['bddSuite.targetBinding'], 'csharp');
  assert.deepStrictEqual(settings['bddSuite.offlineActions'], ['core.*', 'wait', 'orderService.echo']);
  assert.deepStrictEqual(settings['bddSuite.bindings'], {
    csharp: {
      tool: ['bindings/dotnet/artifacts/bin/OrderService.Suite.Cli/Debug/net10.0/suiterun.exe'],
      build: { command: 'dotnet build bindings/dotnet/OrderService.Suite.Cli/OrderService.Suite.Cli.csproj -c Debug', cwd: '.' },
    },
  });
  assert.deepStrictEqual((parseJsonc(file(p, '.vscode/extensions.json')) as { recommendations: string[] }).recommendations,
    ['asz.bdd-suite', 'ms-dotnettools.csharp']);
  const catalog = parseCatalog(file(p, 'schema/actions.catalog.yaml'), '/w/schema/actions.catalog.yaml');
  assert.deepStrictEqual(catalog.errors, []);
  assert.deepStrictEqual(catalog.bindings, ['csharp']);
  assert.deepStrictEqual(catalog.ownSources, { csharp: ['../bindings/dotnet/OrderService.Suite/**/*.cs'] });
  assert.deepStrictEqual([...catalog.actions.keys()], ['orderService.echo']);
  assert.match(file(p, 'bindings/dotnet/Directory.Packages.props'), /<BddSuiteVersion[^>]*>9\.8\.7<\/BddSuiteVersion>/);
  // Declare action's next registration goes after this one, its handler into OrderServiceActions.cs.
  const extension = file(p, 'bindings/dotnet/OrderService.Suite/OrderServiceExtension.cs');
  assert.match(extension, /^ {8}\["orderService\.echo"\] = OrderServiceActions\.OrderServiceEcho,$/m);
  assert.strictEqual(csharpHandlerClass(extension), 'OrderServiceActions');
  assert.match(file(p, 'bindings/dotnet/OrderService.Suite/OrderServiceActions.cs'), /^public static class OrderServiceActions$/m);
  const tests = YAML.parse(file(p, 'bindings/dotnet/OrderService.Suite.MsTest/bddsuite.tests.yaml')) as Record<string, unknown>;
  assert.deepStrictEqual(tests.extensions, ['OrderService.Suite.OrderServiceExtension']);
  assert.deepStrictEqual(tests.offlineActions, ['core.*', 'wait', 'orderService.echo']);
  const suite = YAML.parse(file(p, 'suites/order-service.yml')) as { suite: string; tests: { steps: { action: string }[] }[] };
  assert.strictEqual(suite.suite, 'order-service');
  assert.deepStrictEqual(suite.tests[0].steps.map(s => s.action), ['orderService.echo', 'core.noop']);
  assert.strictEqual(file(p, '.gitignore'), '# suiterun reports and traces.\nout/\n\n# C# build output, generated tests (obj\\...\\BddSuite\\*.g.cs) and test results.\nbindings/dotnet/artifacts/\n');
});

test('PowerShell: the files a PowerShell workspace needs, and Declare action\'s stub file beside its first action', () => {
  const p = plan(['powershell']);
  const paths = p.files.map(f => f.path).sort();
  assert.deepStrictEqual(paths, [
    '.gitignore', '.vscode/extensions.json', '.vscode/settings.json', 'README.md',
    'bindings/powershell/Invoke-Tests.ps1', 'bindings/powershell/OrderService/OrderService.psm1',
    'bindings/powershell/OrderService/actions/OrderServiceEcho.ps1', 'bindings/powershell/bddsuite.tests.yaml', 'bindings/powershell/suiterun.ps1',
    'packages.psd1', 'restore.ps1', 'schema/actions.catalog.yaml', 'suites/order-service.yml',
  ]);
  const settings = parseJsonc(file(p, '.vscode/settings.json')) as Record<string, Record<string, Record<string, unknown>>>;
  const binding = settings['bddSuite.bindings'].powershell;
  assert.deepStrictEqual(binding.tool, ['pwsh', '-NoProfile', '-NonInteractive', '-File', 'bindings/powershell/suiterun.ps1']);
  assert.strictEqual(powershellStubFile('orderService.echo', binding.stubFile as string), 'bindings/powershell/OrderService/actions/OrderServiceEcho.ps1');
  const catalog = parseCatalog(file(p, 'schema/actions.catalog.yaml'), '/w/schema/actions.catalog.yaml');
  assert.deepStrictEqual(catalog.ownSources, { powershell: ['../bindings/powershell/OrderService/actions/*.ps1'] });
  assert.match(file(p, 'bindings/powershell/OrderService/actions/OrderServiceEcho.ps1'), /Register-SuiteAction -Name 'orderService\.echo'/);
  assert.match(file(p, 'packages.psd1'), /Version = '9\.8\.7'\s+Nupkg {3}= 'https:\/\/github\.com\/smartpcr\/bdd-code-extension\/releases\/download\/v9\.8\.7\/BddSuite\.9\.8\.7\.nupkg'/);
  assert.match(file(p, 'bindings/powershell/suiterun.ps1'), /'OrderService\/OrderService\.psm1'/);
});

test('both languages: one catalog and settings with both bindings, the first chosen as the target, READMEs joined', () => {
  const p = plan(['powershell', 'csharp']);
  const settings = parseJsonc(file(p, '.vscode/settings.json')) as Record<string, unknown>;
  assert.strictEqual(settings['bddSuite.targetBinding'], 'powershell');
  assert.strictEqual(settings['bddSuite.lintTool'], 'powershell');
  assert.deepStrictEqual(Object.keys(settings['bddSuite.bindings'] as object), ['powershell', 'csharp']);
  const catalog = parseCatalog(file(p, 'schema/actions.catalog.yaml'), '/w/schema/actions.catalog.yaml');
  assert.deepStrictEqual(catalog.bindings, ['powershell', 'csharp']);
  assert.deepStrictEqual(catalog.actions.get('orderService.echo')?.bindings, ['powershell', 'csharp']);
  assert.deepStrictEqual(Object.keys(catalog.ownSources ?? {}), ['powershell', 'csharp']);
  const readme = file(p, 'README.md');
  assert.match(readme, /^# order-service suites\n/);
  assert.match(readme, /PowerShell and C# binding/);
  assert.ok(readme.indexOf('## The PowerShell binding') < readme.indexOf('## The C# binding'), 'the language sections follow the chosen order');
  assert.ok(p.files.some(f => f.path === 'restore.ps1') && p.files.some(f => f.path === 'nuget.config'));
});
