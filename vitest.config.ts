import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts (whose root is web/) so tests run from the repo root.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
