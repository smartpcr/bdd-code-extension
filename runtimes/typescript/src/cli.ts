#!/usr/bin/env node
// suiterun: the TypeScript runtime's command line.
//
// DEC-Y14 gives every binding the same four verbs and three exit codes:
//
//   suiterun lint    --path <glob> [--json] [--strict] [--binding-check] [--binding <name>]
//   suiterun run     --path <glob> [--tags a,b] [--results f.xml] [--format nunit3|junit]
//                    [--dry-run] [--param name=value] [--trace-file f.json]
//                    [any option an extension declares, with its value]
//   suiterun list    --path <glob> [--tags a,b]
//   suiterun actions [--json]
//
// The arguments are read by hand, not by a library: the exit code is part of
// the contract, and an unknown argument has to be 2 with this usage text, not
// whatever a library chooses to print.
//
// A consumer's own suiterun calls main(argv, streams, extensions): each
// extension's options are taken like the core's valued flags (extension.ts).
import { fileURLToPath } from 'node:url';
import { coreActions } from './actions/core.js';
import { compose, Composite, Extension, ExtensionError } from './extension.js';
import { execute } from './run.js';

export type Verb = 'lint' | 'run' | 'list' | 'actions';
export type ReportFormat = 'nunit3' | 'junit';

/** Every selected case passed, or validation found nothing. */
export const EXIT_PASSED = 0;
/** A case failed. Only a run produces this. */
export const EXIT_FAILED = 1;
/** A validation error, or the tool could not do its job at all. */
export const EXIT_REFUSED = 2;

export interface Options {
  verb: Verb;
  path: string;
  tags: string[];
  results: string;
  traceFile: string;
  format: ReportFormat;
  params: [string, string][];
  binding: string;
  json: boolean;
  strict: boolean;
  dryRun: boolean;
  bindingCheck: boolean;
  schemaRoot: string;
  /** The value given for each option an extension declares, by flag. */
  extensionOptions: Map<string, string>;
}

export const USAGE = `suiterun lint    --path <glob> [--json] [--strict] [--binding-check] [--binding <name>]
suiterun run     --path <glob> [--tags a,b] [--results f.xml] [--format nunit3|junit]
                 [--dry-run] [--param name=value] [--trace-file f.json]
suiterun list    --path <glob> [--tags a,b]
suiterun actions [--json]`;

/** The usage text, with every option the extensions declare. */
export const usage = (composite?: Composite): string => (composite?.options.length
  ? `${USAGE}\nOptions the extensions add, for run:\n${composite.options.map(o => `                 ${o.flag} <value>  ${o.description}`).join('\n')}`
  : USAGE);

/** Why a command line cannot be read; the message is what the tool prints. */
export class UsageError extends Error {}

const VERBS: readonly Verb[] = ['lint', 'run', 'list', 'actions'];
const SWITCHES = new Set(['--json', '--strict', '--dry-run', '--binding-check']);
const VALUED = new Set(['--path', '--tags', '--results', '--trace-file', '--schema-root', '--binding', '--format', '--param']);

/** One command line, or a UsageError saying why it cannot be read; an extension's option is a valued flag like the core's. */
export function parse(argv: readonly string[], composite?: Composite): Options {
  const USAGE = usage(composite);
  const extensionFlags = new Set(composite?.options.map(o => o.flag) ?? []);
  const options: Options = {
    verb: 'actions', path: '', tags: [], results: '', traceFile: '', format: 'nunit3', params: [], binding: 'typescript',
    json: false, strict: false, dryRun: false, bindingCheck: false, schemaRoot: '', extensionOptions: new Map(),
  };
  const first = argv[0];
  if (first === undefined) throw new UsageError(`a verb is needed.\n${USAGE}`);
  if (!(VERBS as readonly string[]).includes(first)) throw new UsageError(`there is no verb called ${first}.\n${USAGE}`);
  options.verb = first as Verb;

  for (let i = 1; i < argv.length; i++) {
    const name = argv[i]!;
    if (SWITCHES.has(name)) {
      if (name === '--json') options.json = true;
      else if (name === '--strict') options.strict = true;
      else if (name === '--dry-run') options.dryRun = true;
      else options.bindingCheck = true;
      continue;
    }
    if (!VALUED.has(name) && !extensionFlags.has(name)) throw new UsageError(`${options.verb} does not take ${name}.\n${USAGE}`);
    // A flag that takes a value never takes the next flag as its value.
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} needs a value after it.\n${USAGE}`);
    i++;
    if (extensionFlags.has(name)) {
      options.extensionOptions.set(name, value);
      continue;
    }
    switch (name) {
      case '--path': options.path = value; break;
      case '--tags': options.tags.push(...value.split(',').map(t => t.trim()).filter(Boolean)); break;
      case '--results': options.results = value; break;
      case '--trace-file': options.traceFile = value; break;
      case '--schema-root': options.schemaRoot = value; break;
      case '--binding': options.binding = value; break;
      case '--format':
        if (value !== 'nunit3' && value !== 'junit') throw new UsageError(`--format is nunit3 or junit, not ${value}.\n${USAGE}`);
        options.format = value;
        break;
      default: {
        const at = value.indexOf('=');
        if (at <= 0) throw new UsageError(`--param takes name=value, and ${value} is not one.\n${USAGE}`);
        options.params.push([value.slice(0, at), value.slice(at + 1)]);
      }
    }
  }
  // Every verb but actions reads suite files, so it has to be told which.
  if (options.verb !== 'actions' && !options.path) throw new UsageError(`${options.verb} needs --path.\n${USAGE}`);
  return options;
}

/** Output written by one call per stream, so a large document is never interleaved or cut off. */
export interface Streams {
  out(text: string): void;
  err(text: string): void;
}

const processStreams: Streams = {
  out: text => void process.stdout.write(text),
  err: text => void process.stderr.write(text),
};

/** Runs one command line with the given extensions and gives back its exit code; it never calls process.exit(). */
export async function main(argv: readonly string[], streams: Streams = processStreams, extensions: readonly Extension[] = []): Promise<number> {
  let options: Options;
  let composite: Composite;
  try {
    composite = compose(extensions, coreActions);
    options = parse(argv, composite);
  } catch (e) {
    if (!(e instanceof UsageError) && !(e instanceof ExtensionError)) throw e;
    streams.err(`suiterun: ${e.message}\n`);
    return EXIT_REFUSED;
  }
  const report = await execute(options, composite);
  if (report.out) streams.out(`${report.out}\n`);
  if (report.errors) streams.err(`suiterun: ${report.errors}\n`);
  return report.code;
}

/* c8 ignore next 3 -- the program entry, run by the conformance tests as a child process */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
