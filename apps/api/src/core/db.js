import knex from 'knex';
import pg from 'pg';
import knexConfig from '../../knexfile.js';
import { AppError } from './errors.js';

// Return SQL `date` values as 'YYYY-MM-DD' strings. The default converts them to a JS Date at local
// midnight, which can shift holidays, joining dates and attendance days by one across timezones.
// (`numeric` already comes back as a string, which keeps money exact.)
const DATE_OID = 1082;
pg.types.setTypeParser(DATE_OID, (value) => value);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);

/**
 * Creates the shared PostgreSQL connection pool. Schema changes happen only through migrations in
 * src/db/migrations, never at startup.
 *
 * Row-level security is FORCED on tenant tables, so a query made directly on this pool, outside
 * withTenant() or withSystem(), sees no tenant rows (fail closed).
 */
export function createDb(config) {
  return knex({ ...knexConfig, connection: config.DATABASE_URL });
}

/**
 * Runs `fn(trx)` in a transaction scoped to one organization. PostgreSQL row-level security then
 * rejects rows from other tenants, even if a query forgets its organization_id filter. The setting is
 * transaction-local, so it never leaks through pooled connections (safe with Neon's PgBouncer
 * transaction pooling).
 *
 * Repositories must still filter by organization_id explicitly; RLS is the second layer.
 */
export async function withTenant(db, organizationId, fn) {
  if (!isUuid(organizationId)) {
    throw new AppError(500, 'TENANT_CONTEXT_MISSING', 'Tenant context is missing');
  }
  return db.transaction(async (trx) => {
    await trx.raw(
      "SELECT set_config('app.current_organization_id', ?, true), set_config('app.rls_bypass', 'off', true)",
      [organizationId],
    );
    return fn(trx);
  });
}

/**
 * Runs `fn(trx)` with row-level security bypassed for this transaction only.
 *
 * ONLY for work that must happen before a tenant is known: the login lookup by email, the refresh-token
 * lookup, organization bootstrap, and test setup. Never use it in request handlers for tenant data.
 */
export async function withSystem(db, fn) {
  return db.transaction(async (trx) => {
    await trx.raw("SELECT set_config('app.rls_bypass', 'on', true)");
    return fn(trx);
  });
}
