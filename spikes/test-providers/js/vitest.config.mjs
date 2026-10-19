import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['vitest/**/*.test.mjs'], globalSetup: ['vitest/globalSetup.mjs'] } });
