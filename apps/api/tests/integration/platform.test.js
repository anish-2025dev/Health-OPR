import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { CSRF, PASSWORD, bearer, createTenant, login, setupTestApp, sys } from './helpers.js';
import { hashPassword } from '../../src/modules/authentication/passwords.js';

// Fictional data only.
const { app, db } = setupTestApp();
const s = randomUUID().slice(0, 6);
const adminEmail = `ops-${s}@platform.test`;
let token;
let cookie;
let hospital;
let other;

const p = () => ({
  get: (url) => request(app).get(`/api/v1/platform${url}`).set(bearer(token)),
  post: (url, body = {}) =>
    request(app).post(`/api/v1/platform${url}`).set(bearer(token)).send(body),
});

beforeAll(async () => {
  other = await createTenant(db, 'plat');
  await sys(db, async (x) =>
    x('platform_admins').insert({
      email: adminEmail,
      full_name: 'Ops Person',
      password_hash: await hashPassword(PASSWORD),
      must_change_password: false,
    }),
  );
});
afterAll(() => db.destroy());

describe('platform sign-in', () => {
  it('signs in separately from hospital logins', async () => {
    const bad = await request(app)
      .post('/api/v1/platform/auth/login')
      .send({ email: adminEmail, password: 'wrong-password-123' });
    expect(bad.status).toBe(401);
    const ok = await request(app)
      .post('/api/v1/platform/auth/login')
      .send({ email: adminEmail, password: PASSWORD });
    expect(ok.status).toBe(200);
    token = ok.body.accessToken;
    cookie = ok.headers['set-cookie'][0].split(';')[0];
    expect((await p().get('/me')).body.email).toBe(adminEmail);
  });

  it('platform and hospital tokens are not interchangeable', async () => {
    expect((await request(app).get('/api/v1/users').set(bearer(token))).status).toBe(401);
    const hospitalToken = (await login(app, other.owner.email)).token;
    expect(
      (await request(app).get('/api/v1/platform/organizations').set(bearer(hospitalToken))).status,
    ).toBe(401);
    // a hospital owner's password does not open the platform console
    const cross = await request(app)
      .post('/api/v1/platform/auth/login')
      .send({ email: other.owner.email, password: PASSWORD });
    expect(cross.status).toBe(401);
  });

  it('refresh rotates; reusing an old cookie ends the sessions', async () => {
    const r = await request(app)
      .post('/api/v1/platform/auth/refresh')
      .set(CSRF)
      .set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(
      (await request(app).post('/api/v1/platform/auth/refresh').set(CSRF).set('Cookie', cookie))
        .status,
    ).toBe(401);
  });
});

describe('onboarding a hospital', () => {
  let invite;

  it('creates the hospital, its main branch and an owner with a one-time link', async () => {
    const r = await p().post('/organizations', {
      name: 'Lotus Test Hospital',
      code: `lotus-${s}`,
      ownerName: 'Lotus Owner',
      ownerEmail: `owner-${s}@lotus.test`,
    });
    expect(r.status).toBe(201);
    hospital = r.body;
    invite = r.body.invite.url;
    expect(hospital).toMatchObject({
      code: `lotus-${s}`,
      status: 'active',
      counts: { branches: 1, staff: 1 },
    });
    expect(hospital.owners[0]).toMatchObject({ email: `owner-${s}@lotus.test`, activated: false });
    expect(invite).toContain('/invite?token=');
    // the owner can't sign in until they set a password
    const early = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: `owner-${s}@lotus.test`, password: PASSWORD });
    expect(early.status).toBe(401);
  });

  it('refuses a code or email that is already used', async () => {
    const dupCode = await p().post('/organizations', {
      name: 'Again',
      code: `lotus-${s}`,
      ownerName: 'X Person',
      ownerEmail: `x-${s}@x.test`,
    });
    expect(dupCode.body.error.code).toBe('CODE_TAKEN');
    const dupEmail = await p().post('/organizations', {
      name: 'Again',
      code: `lotus2-${s}`,
      ownerName: 'X Person',
      ownerEmail: other.owner.email,
    });
    expect(dupEmail.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('the owner sets a password from the link and is signed in; the link works once', async () => {
    const t = new URL(invite).searchParams.get('token');
    const info = await request(app).get(`/api/v1/auth/invite/${t}`);
    expect(info.body).toMatchObject({
      organizationName: 'Lotus Test Hospital',
      email: `owner-${s}@lotus.test`,
    });
    const weak = await request(app)
      .post('/api/v1/auth/invite/accept')
      .set(CSRF)
      .send({ token: t, password: 'short' });
    expect(weak.status).toBe(400);
    const ok = await request(app)
      .post('/api/v1/auth/invite/accept')
      .set(CSRF)
      .send({ token: t, password: PASSWORD });
    expect(ok.status).toBe(200);
    const me = await request(app).get('/api/v1/auth/me').set(bearer(ok.body.accessToken));
    expect(me.body.roles.map((r) => r.role)).toEqual(['organization_owner']);
    expect(me.body.user.mustChangePassword).toBe(false);
    expect(
      (
        await request(app)
          .post('/api/v1/auth/invite/accept')
          .set(CSRF)
          .send({ token: t, password: PASSWORD })
      ).body.error.code,
    ).toBe('INVITE_INVALID');
    expect((await p().get(`/organizations/${hospital.id}`)).body.owners[0].activated).toBe(true);
  });

  it('a new link replaces the previous one', async () => {
    const ownerId = hospital.owners[0].id;
    const first = await p().post(`/organizations/${hospital.id}/invites`, { userId: ownerId });
    const second = await p().post(`/organizations/${hospital.id}/invites`, { userId: ownerId });
    const t1 = new URL(first.body.url).searchParams.get('token');
    const t2 = new URL(second.body.url).searchParams.get('token');
    expect((await request(app).get(`/api/v1/auth/invite/${t1}`)).status).toBe(400);
    expect((await request(app).get(`/api/v1/auth/invite/${t2}`)).status).toBe(200);
    // only owners of that hospital
    expect(
      (await p().post(`/organizations/${hospital.id}/invites`, { userId: other.owner.id })).status,
    ).toBe(404);
  });

  it('suspending signs everyone out and blocks logins; reactivating restores access', async () => {
    const before = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: `owner-${s}@lotus.test`, password: PASSWORD });
    const sessionToken = before.body.accessToken;
    const susp = await p().post(`/organizations/${hospital.id}/suspend`, {
      reason: 'Contract paused',
    });
    expect(susp.body.status).toBe('suspended');
    expect((await request(app).get('/api/v1/auth/me').set(bearer(sessionToken))).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/v1/auth/login')
          .send({ email: `owner-${s}@lotus.test`, password: PASSWORD })
      ).status,
    ).toBe(403);
    await p().post(`/organizations/${hospital.id}/reactivate`, { reason: 'Contract renewed' });
    expect(
      (
        await request(app)
          .post('/api/v1/auth/login')
          .send({ email: `owner-${s}@lotus.test`, password: PASSWORD })
      ).status,
    ).toBe(200);
  });

  it('lists hospitals with counts only, and keeps a platform audit trail', async () => {
    const list = await p().get('/organizations');
    const row = list.body.data.find((o) => o.id === hospital.id);
    expect(Object.keys(row.counts)).toEqual(['branches', 'staff', 'employees', 'patients']);
    const detail = await p().get(`/organizations/${hospital.id}`);
    expect(detail.body.history.map((h) => h.action)).toEqual(
      expect.arrayContaining([
        'platform.organization_created',
        'platform.organization_suspended',
        'platform.organization_reactivated',
      ]),
    );
  });
});

describe('first sign-in', () => {
  it('a new platform admin must change the temporary password first', async () => {
    const email = `new-${s}@platform.test`;
    await sys(db, async (x) =>
      x('platform_admins').insert({
        email,
        full_name: 'New Ops',
        password_hash: await hashPassword(PASSWORD),
      }),
    );
    const t = (
      await request(app).post('/api/v1/platform/auth/login').send({ email, password: PASSWORD })
    ).body.accessToken;
    const blocked = await request(app).get('/api/v1/platform/organizations').set(bearer(t));
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const changed = await request(app)
      .post('/api/v1/platform/me/password')
      .set(bearer(t))
      .send({ currentPassword: PASSWORD, newPassword: 'another-long-passphrase-42' });
    expect(changed.status).toBe(204);
    expect((await request(app).get('/api/v1/platform/organizations').set(bearer(t))).status).toBe(
      200,
    );
  });
});
