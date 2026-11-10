import { defineConfig } from 'vitest/config';

// Unit tests: no database or Redis required.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    exclude: ['tests/integration/**', 'node_modules/**'],
  },
});
