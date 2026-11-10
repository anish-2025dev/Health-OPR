import knex from 'knex';
import { migrationsDir, testDatabaseUrl } from './test-db.js';

/** Recreates the test database and applies every migration, exactly as a deploy would. */
export default async function setup() {
  const url = new URL(testDatabaseUrl());
  const dbName = url.pathname.slice(1);
  if (!/^[a-z0-9_]*_test$/.test(dbName)) {
    throw new Error(`Refusing to reset "${dbName}": test database names must end with _test`);
  }

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = knex({ client: 'pg', connection: adminUrl.toString() });
  try {
    await admin.raw(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.raw(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.destroy();
  }

  const db = knex({
    client: 'pg',
    connection: url.toString(),
    migrations: { directory: migrationsDir, loadExtensions: ['.js'] },
  });
  try {
    await db.migrate.latest();
  } finally {
    await db.destroy();
  }
}
