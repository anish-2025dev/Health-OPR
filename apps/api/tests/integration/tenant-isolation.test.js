import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { withTenant } from '../../src/core/db.js';
import { bearer, createTenant, login, setupTestApp, sys } from './helpers.js';

const { app, db } = setupTestApp();
let a;
let b;
let tokenA;

beforeAll(async () => {
  a = await createTenant(db, 'tenanta');
  b = await createTenant(db, 'tenantb');
  ({ token: tokenA } = await login(app, a.owner.email));
});
afterAll(() => db.destroy());

describe('API-level isolation: tenant A cannot read or modify tenant B data', () => {
  it('lists only its own users and branches', async () => {
    const users = await request(app).get('/api/v1/users').set(bearer(tokenA));
    expect(users.status).toBe(200);
    const ids = users.body.data.map((u) => u.id);
    expect(ids).toContain(a.owner.id);
    expect(ids).not.toContain(b.owner.id);

    const branches = await request(app).get('/api/v1/branches').set(bearer(tokenA));
    expect(branches.body.data.map((x) => x.id)).not.toContain(b.branch.id);
  });

  it("returns 404 (not 403) for another tenant's branch and leaves it unchanged", async () => {
    const res = await request(app)
      .patch(`/api/v1/branches/${b.branch.id}`)
      .set(bearer(tokenA))
      .send({ name: 'Hijacked' });
    expect(res.status).toBe(404);
    const branch = await sys(db, (t) => t('branches').where({ id: b.branch.id }).first());
    expect(branch.name).toBe('Main');
  });

  it("cannot update, disable, re-role or reset another tenant's user", async () => {
    const id = b.owner.id;
    const patch = await request(app)
      .patch(`/api/v1/users/${id}`)
      .set(bearer(tokenA))
      .send({ status: 'disabled' });
    const roles = await request(app)
      .put(`/api/v1/users/${id}/roles`)
      .set(bearer(tokenA))
      .send({ roles: [{ role: 'employee' }] });
    const reset = await request(app).post(`/api/v1/users/${id}/reset-password`).set(bearer(tokenA));
    expect([patch.status, roles.status, reset.status]).toEqual([404, 404, 404]);
    const user = await sys(db, (t) => t('users').where({ id }).first());
    expect(user.status).toBe('active');
  });

  it('cannot assign a role scoped to another tenant branch', async () => {
    const res = await request(app)
      .post('/api/v1/users')
      .set(bearer(tokenA))
      .send({
        fullName: 'Cross Tenant',
        email: `cross-${Date.now()}@example.test`,
        roles: [{ role: 'receptionist', branchId: b.branch.id }],
      });
    expect(res.status).toBe(400);
  });

  it("does not show another tenant's audit entries", async () => {
    const res = await request(app).get('/api/v1/audit-logs').set(bearer(tokenA));
    expect(res.status).toBe(200);
    const bEntries = await sys(db, (t) =>
      t('audit_logs').where({ organization_id: b.organization.id }).pluck('id'),
    );
    const seen = res.body.data.map((e) => e.id);
    expect(seen.some((id) => bEntries.includes(id))).toBe(false);
  });

  it('the organization endpoint only ever returns the caller organization', async () => {
    const res = await request(app).get('/api/v1/organizations/current').set(bearer(tokenA));
    expect(res.body.id).toBe(a.organization.id);
  });
});

describe('database-level isolation (row-level security)', () => {
  it('hides other tenants rows even when a query forgets the organization filter', async () => {
    const rows = await withTenant(db, a.organization.id, (trx) =>
      trx('users').select('organization_id'),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organization_id === a.organization.id)).toBe(true);

    const orgs = await withTenant(db, a.organization.id, (trx) =>
      trx('organizations').select('id'),
    );
    expect(orgs.map((o) => o.id)).toEqual([a.organization.id]);
  });

  it('blocks writing a row into another tenant', async () => {
    await expect(
      withTenant(db, a.organization.id, (trx) =>
        trx('branches').insert({
          organization_id: b.organization.id,
          name: 'Sneaky',
          code: 'SNEAK',
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('blocks updating or deleting another tenant rows (they are invisible)', async () => {
    const updated = await withTenant(db, a.organization.id, (trx) =>
      trx('branches').where({ id: b.branch.id }).update({ name: 'Changed' }),
    );
    const deleted = await withTenant(db, a.organization.id, (trx) =>
      trx('user_role_assignments').where({ user_id: b.owner.id }).delete(),
    );
    expect(updated).toBe(0);
    expect(deleted).toBe(0);
  });

  it('fails closed: a query with no tenant context sees no rows at all', async () => {
    expect(await db('users').select('id')).toEqual([]);
    expect(await db('organizations').select('id')).toEqual([]);
    const inserted = db('branches').insert({
      organization_id: a.organization.id,
      name: 'X',
      code: 'NOCTX',
    });
    await expect(inserted).rejects.toThrow(/row-level security/);
  });

  it('the API database role is not a superuser and cannot bypass RLS', async () => {
    const { rows } = await db.raw(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('refuses to run tenant work without a valid organization id', async () => {
    await expect(withTenant(db, undefined, async () => {})).rejects.toThrow(/Tenant context/);
    await expect(withTenant(db, "x' OR 1=1 --", async () => {})).rejects.toThrow(/Tenant context/);
  });

  it('audit logs are append-only', async () => {
    await expect(sys(db, (t) => t('audit_logs').update({ action: 'tampered' }))).rejects.toThrow(
      /append-only/,
    );
    await expect(sys(db, (t) => t('audit_logs').delete())).rejects.toThrow(/append-only/);
  });
});
