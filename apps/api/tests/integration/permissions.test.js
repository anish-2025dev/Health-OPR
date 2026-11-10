import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PASSWORD, addUser, bearer, createTenant, login, setupTestApp, sys } from './helpers.js';

const { app, db } = setupTestApp();
let t;
let owner;
let admin;
let receptionist;
let adminUser;

beforeAll(async () => {
  t = await createTenant(db, 'perm');
  adminUser = await addUser(db, t.organization.id, ['organization_admin'], 'admin');
  const recUser = await addUser(db, t.organization.id, ['receptionist'], 'reception');
  owner = (await login(app, t.owner.email)).token;
  admin = (await login(app, adminUser.email)).token;
  receptionist = (await login(app, recUser.email)).token;
});
afterAll(() => db.destroy());

describe('role-based access', () => {
  it('receptionist can read branches but cannot manage them or see users/audit', async () => {
    expect((await request(app).get('/api/v1/branches').set(bearer(receptionist))).status).toBe(200);
    const create = await request(app)
      .post('/api/v1/branches')
      .set(bearer(receptionist))
      .send({ name: 'New', code: 'NEW' });
    expect(create.status).toBe(403);
    expect((await request(app).get('/api/v1/users').set(bearer(receptionist))).status).toBe(403);
    expect((await request(app).get('/api/v1/audit-logs').set(bearer(receptionist))).status).toBe(
      403,
    );
    expect(
      (
        await request(app)
          .patch('/api/v1/organizations/current')
          .set(bearer(receptionist))
          .send({ name: 'X' })
      ).status,
    ).toBe(403);
  });

  it('admin can create a branch, which is audit-logged', async () => {
    const res = await request(app)
      .post('/api/v1/branches')
      .set(bearer(admin))
      .send({ name: 'Second Clinic', code: 'sec-1' });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe('SEC-1');
    const audit = await sys(db, (t) =>
      t('audit_logs').where({ entity_id: res.body.id, action: 'branch.created' }).first(),
    );
    expect(audit.actor_user_id).toBe(adminUser.id);

    const dup = await request(app)
      .post('/api/v1/branches')
      .set(bearer(admin))
      .send({ name: 'Dup', code: 'SEC-1' });
    expect(dup.status).toBe(409);
  });

  it('creating a user returns a one-time temporary password and forces a change', async () => {
    const res = await request(app)
      .post('/api/v1/users')
      .set(bearer(admin))
      .send({
        fullName: 'Front Desk',
        email: `desk-${Date.now()}@example.test`,
        roles: [{ role: 'receptionist', branchId: t.branch.id }],
      });
    expect(res.status).toBe(201);
    expect(res.body.temporaryPassword).toMatch(/^\w{5}-\w{5}-\w{5}-\w{5}$/);
    expect(res.body.user.mustChangePassword).toBe(true);
    expect(JSON.stringify(res.body.user)).not.toMatch(/hash/i);

    const me = await login(app, res.body.user.email, res.body.temporaryPassword);
    const branches = await request(app).get('/api/v1/branches').set(bearer(me.token));
    expect(branches.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });
});

describe('privilege escalation is blocked', () => {
  it('admin cannot grant the owner role', async () => {
    const res = await request(app)
      .post('/api/v1/users')
      .set(bearer(admin))
      .send({
        fullName: 'Wannabe',
        email: `w-${Date.now()}@example.test`,
        roles: [{ role: 'organization_owner' }],
      });
    expect(res.status).toBe(403);
  });

  it('owner can grant the owner role', async () => {
    const res = await request(app)
      .post('/api/v1/users')
      .set(bearer(owner))
      .send({
        fullName: 'Co Owner',
        email: `co-${Date.now()}@example.test`,
        roles: [{ role: 'organization_owner' }],
      });
    expect(res.status).toBe(201);
  });

  it('nobody can change their own roles', async () => {
    const res = await request(app)
      .put(`/api/v1/users/${adminUser.id}/roles`)
      .set(bearer(admin))
      .send({ roles: [{ role: 'organization_owner' }] });
    expect(res.status).toBe(403);
  });

  it("admin cannot disable or reset the owner's account", async () => {
    const disable = await request(app)
      .patch(`/api/v1/users/${t.owner.id}`)
      .set(bearer(admin))
      .send({ status: 'disabled' });
    const reset = await request(app)
      .post(`/api/v1/users/${t.owner.id}/reset-password`)
      .set(bearer(admin));
    expect(disable.status).toBe(403);
    expect(reset.status).toBe(403);
  });

  it('disabling a user ends their sessions immediately', async () => {
    const victim = await addUser(db, t.organization.id, ['nurse'], 'victim');
    const { token } = await login(app, victim.email, PASSWORD);
    const res = await request(app)
      .patch(`/api/v1/users/${victim.id}`)
      .set(bearer(admin))
      .send({ status: 'disabled' });
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/v1/auth/me').set(bearer(token))).status).toBe(401);
  });
});

describe('branch-scoped roles', () => {
  it('a manager scoped to one branch only sees that branch', async () => {
    const second = await request(app)
      .post('/api/v1/branches')
      .set(bearer(admin))
      .send({ name: 'Scoped Other', code: 'OTHER' });
    const scoped = await addUser(
      db,
      t.organization.id,
      [{ role: 'clinic_manager', branchId: t.branch.id }],
      'scoped',
    );
    const { token } = await login(app, scoped.email);
    const res = await request(app).get('/api/v1/branches').set(bearer(token));
    const ids = res.body.data.map((x) => x.id);
    expect(ids).toEqual([t.branch.id]);
    expect(ids).not.toContain(second.body.id);
  });
});
