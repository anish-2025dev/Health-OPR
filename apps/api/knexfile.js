import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env'), quiet: true });

/**
 * Knex configuration used by the app and the migration CLI. Migrations are the only way to change schema.
 *
 * DATABASE_MIGRATION_URL (optional) lets migrations use a direct, non-pooled connection, for example
 * Neon's non "-pooler" host, while the running app uses the pooled DATABASE_URL.
 */
export default {
  client: 'pg',
  connection: process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL,
  pool: { min: 0, max: 10, idleTimeoutMillis: 10_000 },
  migrations: {
    directory: path.resolve(here, 'src/db/migrations'),
    tableName: 'knex_migrations',
    loadExtensions: ['.js'],
  },
};
