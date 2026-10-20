// Vitest runs the tests generated into vitest/. Each test file has its own run
// context in Vitest's default isolation (DEC-T08); --no-isolate with one
// worker shares one per worker.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['vitest/**/*.bdd.test.ts'],
    // JUNIT_FILE (a full path) moves the report; a command line --outputFile does not override this.
    reporters: ['default', ['junit', { outputFile: process.env.JUNIT_FILE || 'out/vitest.xml' }]],
  },
});
