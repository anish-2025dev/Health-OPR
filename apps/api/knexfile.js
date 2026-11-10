import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env'), quiet: true });

/** Knex configuration used by the app and the migration CLI. Migrations are the only way to change schema. */
export default {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 0, max: 10 },
  migrations: {
    directory: path.resolve(here, 'src/db/migrations'),
    tableName: 'knex_migrations',
    loadExtensions: ['.js'],
  },
};
