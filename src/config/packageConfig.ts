// Builds package.json's contributes.configuration from the defaults, so the
// two cannot drift (plan 2.8). Used by scripts/sync-defaults.mjs and a unit test.
import { DEFAULT_SETTINGS, SETTING_DESCRIPTIONS, Settings } from './defaults';

const schemaType = (v: unknown): string =>
  Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v;

export function configurationContribution(): { title: string; properties: Record<string, unknown> } {
  const properties: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const value = DEFAULT_SETTINGS[key];
    const entry: Record<string, unknown> = {
      type: schemaType(value),
      default: value,
      description: SETTING_DESCRIPTIONS[key],
    };
    if (Array.isArray(value)) entry.items = { type: 'string' };
    properties[`bddSuite.${key}`] = entry;
  }
  return { title: 'Suite Authoring', properties };
}
