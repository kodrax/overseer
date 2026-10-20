import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts (whose root is web/) so tests run from the repo root.
export default defineConfig({
  test: {
    // test/web/*.test.tsx are SPA component tests; they pick jsdom with a `@vitest-environment` comment.
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
