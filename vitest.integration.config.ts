import { defineConfig } from 'vitest/config';

/** Config for integration tests that need a real `tree-sitter` binding
 *  (the default unit config mocks it). Requires `npm run build` first
 *  because worker scripts load from dist/. */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    // No tests/setup.ts here — the integration suite MUST see real
    // tree-sitter, not the unit-suite mocks.
    include: ['tests/integration/**/*.test.ts'],
  },
});
