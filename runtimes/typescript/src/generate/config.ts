// A test project's bddsuite.tests.yaml (spec/test-plan.md,
// spec/tests.config.schema.json), read and checked the way the schema checks
// it, with its paths made absolute against its own folder.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadDocument } from '../model.js';
import { isList, isMap, Value } from '../value.js';

/** The providers a config may name. */
export const PROVIDERS = ['mstest', 'nunit', 'xunit', 'go', 'rust', 'node', 'vitest', 'jest', 'mocha', 'pester'] as const;
export type Provider = (typeof PROVIDERS)[number];

const CONFIG_KEYS = ['suites', 'exclude', 'schemaRoot', 'provider', 'extensions', 'offlineActions', 'contextKeys', 'output'];
const OUTPUT_KEYS = ['folder', 'namespace', 'package'];

export interface TestsConfig {
  /** The config file, absolute. */
  file: string;
  /** Its folder, which the other paths are relative to. */
  folder: string;
  suites: string[];
  exclude: string[];
  schemaRoot: string;
  provider?: Provider;
  extensions: string[];
  /** Undefined when the config has none, which guards nothing. */
  offlineActions?: string[];
  contextKeys: string[];
  output: { folder?: string; namespace?: string; package?: string };
}

/** Why a config is refused; the message names the file. */
export class ConfigError extends Error {}

/** Reads one config file, refusing what the schema refuses. */
export function loadConfig(file: string): TestsConfig {
  const full = path.resolve(file);
  const refuse = (message: string) => new ConfigError(`${file}: ${message}`);
  let text: string;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (e) {
    throw new ConfigError(`${file} cannot be read: ${(e as Error).message}`);
  }
  let held: Value;
  try {
    held = loadDocument(text).value;
  } catch (e) {
    throw new ConfigError(`${file} is not valid YAML: ${(e as Error).message}`);
  }
  if (!isMap(held)) throw refuse('it does not hold a YAML mapping.');
  for (const key of held.keys()) if (!CONFIG_KEYS.includes(key)) throw refuse(`${key} is not a config key (spec/tests.config.schema.json).`);
  const texts = (key: string, required: boolean): string[] | undefined => {
    if (!held.has(key)) {
      if (required) throw refuse(`${key} is required.`);
      return undefined;
    }
    const raw = held.get(key);
    if (!isList(raw) || raw.some(item => typeof item !== 'string' || !item)) throw refuse(`${key} is a list of non-empty strings.`);
    return raw as string[];
  };
  const forwardSlashes = (paths: string[]) => {
    const bad = paths.find(p => p.includes('\\'));
    if (bad) throw refuse(`${bad} uses a backslash; paths use forward slashes.`);
  };
  const suites = texts('suites', true)!;
  if (!suites.length) throw refuse('suites names no glob.');
  const exclude = texts('exclude', false) ?? [];
  forwardSlashes([...suites, ...exclude]);
  const schemaRoot = held.get('schemaRoot');
  if (typeof schemaRoot !== 'string' || !schemaRoot) throw refuse('schemaRoot is required.');
  forwardSlashes([schemaRoot]);
  const folder = path.dirname(full);
  const config: TestsConfig = {
    file: full, folder, suites, exclude, schemaRoot: path.resolve(folder, schemaRoot), extensions: texts('extensions', false) ?? [],
    contextKeys: texts('contextKeys', false) ?? [], output: {},
  };
  if (held.has('provider')) {
    const provider = held.get('provider');
    if (!(PROVIDERS as readonly unknown[]).includes(provider)) throw refuse(`provider is one of ${PROVIDERS.join(', ')}, not ${String(provider)}.`);
    config.provider = provider as Provider;
  }
  if (held.has('offlineActions')) {
    config.offlineActions = texts('offlineActions', false)!;
    for (const pattern of config.offlineActions) {
      const star = pattern.indexOf('*');
      if (star >= 0 && (!pattern.endsWith('.*') || star !== pattern.length - 1)) throw refuse(`offlineActions: ${pattern} is a name or prefix.*, with no other star.`);
    }
  }
  if (held.has('output')) {
    const output = held.get('output');
    if (!isMap(output)) throw refuse('output is a mapping.');
    for (const [key, value] of output) {
      if (!OUTPUT_KEYS.includes(key)) throw refuse(`output.${key} is not an output key.`);
      if (typeof value === 'string' && value) config.output[key as 'folder'] = value;
    }
  }
  return config;
}
