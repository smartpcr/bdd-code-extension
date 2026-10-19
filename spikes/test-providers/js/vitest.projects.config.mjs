import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { projects: [
  { test: { name: 'serial', include: ['vitest/state-*.test.mjs'], fileParallelism: false } },
  { test: { name: 'shared', include: ['vitest/state-*.test.mjs'], isolate: false, maxWorkers: 1 } },
] } });
