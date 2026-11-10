import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  CSRF,
  PASSWORD,
  addUser,
  bearer,
  createTenant,
  login,
  setupTestApp,
  sys,
} from './helpers.js';
import { MAX_FAILED_LOGINS } from '../../src/modules/authentication/auth.service.js';

const { app, db } = setupTestApp();
let tenant;

beforeAll(async () => {
  tenant = await createTenant(db, 'auth');
});
afterAll(() => db.destroy());

describe('login', () => {
  it('returns an access token and an HttpOnly, SameSite=Strict refresh cookie', async () => {
    const { token, res } = await login(app, tenant.owner.email);
    expect(token).toBeTruthy();
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('hos_refresh='));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const wrong = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: tenant.owner.email, password: 'not-the-password' });
    const unknown = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.test', password: 'whatever-password' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe(unknown.body.error.code);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('locks the account after repeated failures and records it in the audit log', async () => {
    const user = await addUser(db, tenant.organization.id, ['receptionist'], 'lockme');
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: 'bad-password-x' });
    }
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(423);
    const audit = await sys(db, (t) =>
      t('audit_logs').where({ entity_id: user.id, action: 'auth.account_locked' }),
    );
    expect(audit).toHaveLength(1);
  });

  it('rejects disabled users', async () => {
    const user = await addUser(db, tenant.organization.id, ['nurse'], 'disabled');
    await sys(db, (t) => t('users').where({ id: user.id }).update({ status: 'disabled' }));
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(403);
  });

  it('validates input without echoing the password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: 'secret-value-123' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('secret-value-123');
  });
});

describe('me and authentication', () => {
  it('returns the user, organization, roles and permissions', async () => {
    const { token } = await login(app, tenant.owner.email);
    const res = await request(app).get('/api/v1/auth/me').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.organization.id).toBe(tenant.organization.id);
    expect(res.body.roles[0].role).toBe('organization_owner');
    expect(res.body.permissions).toContain('users.manage');
  });

  it('rejects missing, malformed and tampered tokens', async () => {
    const { token } = await login(app, tenant.owner.email);
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set(bearer('abc'))).status).toBe(401);
    const tampered = token.slice(0, -3) + (token.endsWith('AAA') ? 'BBB' : 'AAA');
    expect((await request(app).get('/api/v1/auth/me').set(bearer(tampered))).status).toBe(401);
  });
});

describe('refresh rotation', () => {
  it('rotates the refresh token and issues a new access token', async () => {
    const { cookie } = await login(app, tenant.owner.email);
    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).set(CSRF);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    const next = res.headers['set-cookie'].find((c) => c.startsWith('hos_refresh='));
    expect(next.split(';')[0]).not.toBe(cookie);
  });

  it('requires the CSRF header on cookie-authenticated routes', async () => {
    const { cookie } = await login(app, tenant.owner.email);
    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_CHECK_FAILED');
  });

  it('revokes the whole session family when an old refresh token is replayed', async () => {
    const { cookie, token } = await login(app, tenant.owner.email);
    const first = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).set(CSRF);
    const newCookie = first.headers['set-cookie']
      .find((c) => c.startsWith('hos_refresh='))
      .split(';')[0];

    // Pretend the rotation happened long ago, so the replay is not a parallel-tab race.
    await sys(db, (t) =>
      t('auth_sessions')
        .whereNotNull('rotated_at')
        .update({ rotated_at: new Date(Date.now() - 60_000) }),
    );

    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).set(CSRF);
    expect(replay.status).toBe(401);
    // The legitimate newer token is revoked too, and so is the access token's session.
    const after = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', newCookie)
      .set(CSRF);
    expect(after.status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set(bearer(token))).status).toBe(401);
  });
});

describe('logout', () => {
  it('ends the session immediately, including outstanding access tokens', async () => {
    const { cookie, token } = await login(app, tenant.owner.email);
    const out = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set(CSRF);
    expect(out.status).toBe(204);
    expect((await request(app).get('/api/v1/auth/me').set(bearer(token))).status).toBe(401);
    expect(
      (await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).set(CSRF)).status,
    ).toBe(401);
  });
});

describe('temporary passwords', () => {
  it('blocks everything except me/change-password/logout until the password is changed', async () => {
    const user = await addUser(db, tenant.organization.id, ['organization_admin'], 'temp');
    await sys(db, (t) => t('users').where({ id: user.id }).update({ must_change_password: true }));
    const { token } = await login(app, user.email);

    const blocked = await request(app).get('/api/v1/branches').set(bearer(token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const me = await request(app).get('/api/v1/auth/me').set(bearer(token));
    expect(me.body.user.mustChangePassword).toBe(true);

    const weak = await request(app)
      .post('/api/v1/auth/change-password')
      .set(bearer(token))
      .send({ currentPassword: PASSWORD, newPassword: 'short' });
    expect(weak.status).toBe(400);

    const changed = await request(app)
      .post('/api/v1/auth/change-password')
      .set(bearer(token))
      .send({ currentPassword: PASSWORD, newPassword: 'a-much-better-passphrase' });
    expect(changed.status).toBe(204);
    expect((await request(app).get('/api/v1/branches').set(bearer(token))).status).toBe(200);
  });
});
