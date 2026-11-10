import knex from 'knex';
import knexConfig from '../../knexfile.js';

/**
 * Creates the shared PostgreSQL connection pool.
 *
 * Tenant isolation (Phase 2): tenant-scoped queries will run inside a transaction that first calls
 *   SELECT set_config('app.current_organization_id', $1, true)
 * so PostgreSQL row-level security policies can enforce isolation as defence in depth.
 * Schema changes happen only through migrations in src/db/migrations, never at startup.
 */
export function createDb(config) {
  return knex({ ...knexConfig, connection: config.DATABASE_URL });
}
