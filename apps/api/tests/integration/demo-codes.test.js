import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { CSRF, bearer, createTenant, setupTestApp, sys } from './helpers.js';
import { createOrganizationWithOwner } from '../../src/modules/organizations/index.js';

// Fictional people only. The demo hospital's numbers are in the +91 90000 00xxx range.
const DEMO = `demo-${randomUUID().slice(0, 8)}`;
const { app, db, sms } = setupTestApp({ SMS_DEMO_CODES: 'true', DEMO_HOSPITAL_CODE: DEMO });
const normal = setupTestApp(); // a deployment without demo codes
let demoOrg;
let other;

async function addEmployee(orgId, branchId, mobile, name) {
  await sys(db, (x) =>
    x('employees').insert({
      organization_id: orgId,
      employee_number: `D-${randomUUID().slice(0, 6)}`.toUpperCase(),
      full_name: name,
      mobile_e164: mobile,
      branch_id: branchId,
      joining_date: '2025-01-01',
    }),
  );
}

beforeAll(async () => {
  demoOrg = await createOrganizationWithOwner(db, {
    name: 'Demo Codes Hospital',
    slug: DEMO,
    owner: { email: `owner-${DEMO}@example.test`, fullName: 'Demo Owner' },
    branch: { name: 'Main', code: 'MAIN' },
    passwordHash: null,
  });
  await sys(db, (x) =>
    x('branches')
      .where({ id: demoOrg.branch.id })
      .update({ latitude: 12.9716, longitude: 77.5946, geofence_radius_m: 50 }),
  );
  other = await createTenant(db, 'demob');
  await addEmployee(demoOrg.organization.id, demoOrg.branch.id, '+919000000102', 'Ravi Demo');
  await addEmployee(demoOrg.organization.id, demoOrg.branch.id, '+919811122233', 'Real Number');
  await addEmployee(other.organization.id, other.branch.id, '+919000000103', 'Other Hospital');
});
afterAll(async () => {
  await db.destroy();
  await normal.db.destroy();
});

const requestCode = (a, company, mobile) =>
  request(a).post('/api/v1/auth/employee/request-otp').send({ company, mobile });

describe('demo sign-in codes', () => {
  it('shows the code for a demo number in the demo hospital instead of sending SMS', async () => {
    sms.sent.splice(0);
    const r = await requestCode(app, DEMO, '9000000102');
    expect(r.body.demoCode).toMatch(/^\d{6}$/);
    expect(sms.sent).toHaveLength(0);
    const ok = await request(app)
      .post('/api/v1/auth/employee/verify-otp')
      .send({ company: DEMO, mobile: '9000000102', code: r.body.demoCode });
    expect(ok.status).toBe(200);

    // attendance codes too
    const token = ok.body.accessToken;
    const today = await request(app).get('/api/v1/me/attendance/today').set(bearer(token));
    expect(today.body.smsAvailable).toBe(true);
    const start = await request(app)
      .post('/api/v1/me/attendance/start')
      .set(bearer(token))
      .send({ latitude: 12.97162, longitude: 77.5946, accuracy: 8 });
    expect(start.body.demoCode).toMatch(/^\d{6}$/);
  });

  it('never for real numbers, other hospitals, or deployments without demo codes', async () => {
    sms.sent.splice(0);
    const real = await requestCode(app, DEMO, '9811122233');
    expect(real.body.demoCode).toBeUndefined();
    expect(sms.sent).toHaveLength(1);
    const otherHospital = await requestCode(app, other.organization.slug, '9000000103');
    expect(otherHospital.body.demoCode).toBeUndefined();
    const off = await requestCode(normal.app, DEMO, '9000000102');
    expect(off.body.demoCode).toBeUndefined();
  });

  it('patients: demo numbers get the code on screen and can join only the demo hospital', async () => {
    const r = await request(app)
      .post('/api/v1/patient-auth/otp/request')
      .send({ phone: '9000000201' });
    expect(r.body.demoCode).toMatch(/^\d{6}$/);
    const ok = await request(app)
      .post('/api/v1/patient-auth/otp/verify')
      .send({ phone: '9000000201', code: r.body.demoCode });
    const token = ok.body.accessToken;
    const wrong = await request(app)
      .post('/api/v1/patient/clinics')
      .set(bearer(token))
      .send({ code: other.organization.slug });
    expect(wrong.body.error.code).toBe('DEMO_NUMBER');
    const right = await request(app)
      .post('/api/v1/patient/clinics')
      .set(bearer(token))
      .send({ code: DEMO });
    expect(right.status).toBe(201);
    // real patient numbers still get a real SMS
    const realPatient = await request(app)
      .post('/api/v1/patient-auth/otp/request')
      .send({ phone: '9811199988' });
    expect(realPatient.body.demoCode).toBeUndefined();
    expect(CSRF).toBeTruthy();
  });
});
