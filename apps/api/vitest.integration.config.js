import { defineConfig } from 'vitest/config';

// Integration tests: need PostgreSQL (`make up`). They create and migrate a separate test database.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.js'],
    globalSetup: ['tests/integration/global-setup.js'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
