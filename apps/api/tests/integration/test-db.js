import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../../../.env'), quiet: true });

/**
 * Integration tests use their own database so they never touch development data.
 * Override with TEST_DATABASE_URL; by default it is DATABASE_URL with the database name `healthos_test`.
 */
export function testDatabaseUrl() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const base = new URL(
    process.env.DATABASE_URL ?? 'postgres://healthos:change-me-dev-only@localhost:5432/healthos',
  );
  base.pathname = '/healthos_test';
  return base.toString();
}

export const migrationsDir = path.resolve(here, '../../src/db/migrations');
