import { randomUUID } from 'node:crypto';
import knex from 'knex';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { createLogger } from '../../src/core/logger.js';
import { createMemoryStore } from '../../src/core/rate-limit.js';
import { withSystem } from '../../src/core/db.js';
import { createOrganizationWithOwner } from '../../src/modules/organizations/index.js';
import { hashPassword } from '../../src/modules/authentication/passwords.js';
import { testDatabaseUrl } from './test-db.js';
import { createMemorySms } from '../../src/integrations/sms/index.js';

export const PASSWORD = 'correct-horse-battery-staple';
export const CSRF = { 'X-Requested-With': 'healthos-web' };

export function setupTestApp() {
  const config = loadConfig({
    APP_ENV: 'test',
    APP_SECRET_KEY: 'test-secret-key-that-is-long-enough-123456',
    DATABASE_URL: testDatabaseUrl(),
  });
  const db = knex({ client: 'pg', connection: config.DATABASE_URL, pool: { min: 0, max: 5 } });
  const sms = createMemorySms();
  const app = createApp({
    config,
    logger: createLogger(config),
    db,
    sms,
    rateLimitStore: createMemoryStore(),
    checks: { postgres: () => db.raw('select 1') },
  });
  return { app, db, config, sms };
}

const suffix = () => randomUUID().slice(0, 8);

/** Creates an organization whose owner has a known password and no forced password change. */
export async function createTenant(db, label = 'org') {
  const s = suffix();
  const result = await createOrganizationWithOwner(db, {
    name: `Test ${label} ${s}`,
    slug: `${label}-${s}`.toLowerCase(),
    owner: { email: `owner-${label}-${s}@example.test`, fullName: `Owner ${label}` },
    branch: { name: 'Main', code: 'MAIN' },
    passwordHash: await hashPassword(PASSWORD),
  });
  await withSystem(db, (t) =>
    t('users').where({ id: result.owner.id }).update({ must_change_password: false }),
  );
  return result;
}

/** Adds a user with the given roles and a known password (no forced change). */
export async function addUser(db, organizationId, roles, label = 'user') {
  const passwordHash = await hashPassword(PASSWORD);
  return withSystem(db, async (t) => {
    const [user] = await t('users')
      .insert({
        organization_id: organizationId,
        email: `${label}-${suffix()}@example.test`,
        full_name: `Test ${label}`,
        password_hash: passwordHash,
      })
      .returning('*');
    await t('user_role_assignments').insert(
      roles.map((r) =>
        typeof r === 'string'
          ? { organization_id: organizationId, user_id: user.id, role_key: r, branch_id: null }
          : {
              organization_id: organizationId,
              user_id: user.id,
              role_key: r.role,
              branch_id: r.branchId,
            },
      ),
    );
    return user;
  });
}

/** Test-only shortcut for setup and assertions that need to see across tenants. */
export const sys = (db, fn) => withSystem(db, fn);

export async function login(app, email, password = PASSWORD) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200)
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = res.headers['set-cookie'].find((c) => c.startsWith('hos_refresh='));
  return { token: res.body.accessToken, cookie: cookie.split(';')[0], res };
}

export const bearer = (token) => ({ Authorization: `Bearer ${token}` });
