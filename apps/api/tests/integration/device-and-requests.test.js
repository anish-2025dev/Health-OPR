import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addUser, bearer, createTenant, login, setupTestApp, sys } from './helpers.js';

const { app, db, sms } = setupTestApp();

let t;
let hr;
let worker;
let workerToken;
let nightShift;

const api = (token) => ({
  get: (url) => request(app).get(`/api/v1${url}`).set(bearer(token)),
  post: (url, body = {}) => request(app).post(`/api/v1${url}`).set(bearer(token)).send(body),
});

beforeAll(async () => {
  t = await createTenant(db, 'devreq');

  const hrUser = await addUser(db, t.organization.id, ['hr_manager'], 'hr');
  hr = api((await login(app, hrUser.email)).token);

  // Create a night shift
  const shiftRes = await hr.post('/shifts', {
    name: 'Night Shift',
    startTime: '20:00',
    endTime: '08:00',
    breakMinutes: 60,
  });
  nightShift = shiftRes.body;

  const workerRes = await hr.post('/hr/employees', {
    fullName: 'Derek Device',
    mobile: '9500000001',
    branchId: t.branch.id,
    joiningDate: '2026-01-01',
    emergencyContactName: 'Original Contact',
  });
  worker = workerRes.body;
});

afterAll(async () => {
  await db.destroy();
});

describe('Device Restriction & Operations Integration Tests (§3.2, §7.2, §8.2)', () => {
  it('Employee logs in on device A, and second login on device B is restricted (§3.2)', async () => {
    const mobile = '9500000001';
    const company = t.organization.slug;

    // 1. Request OTP
    await sys(db, (x) =>
      x('otp_challenges').update({ created_at: x.raw("created_at - interval '1 minute'") }),
    );
    await request(app).post('/api/v1/auth/employee/request-otp').send({ company, mobile });
    let code = sms.lastCodeFor(`+91${mobile}`);

    // 2. Verify OTP on Device A
    const loginA = await request(app).post('/api/v1/auth/employee/verify-otp').send({
      company,
      mobile,
      code,
      deviceFingerprint: 'device-fingerprint-A',
      deviceLabel: 'Chrome on Pixel 8',
    });
    expect(loginA.status).toBe(200);
    workerToken = loginA.body.accessToken;

    // 3. Request OTP for second device
    await sys(db, (x) =>
      x('otp_challenges').update({ created_at: x.raw("created_at - interval '1 minute'") }),
    );
    await request(app).post('/api/v1/auth/employee/request-otp').send({ company, mobile });
    code = sms.lastCodeFor(`+91${mobile}`);

    // 4. Verify OTP on Device B (must be restricted)
    const loginB = await request(app).post('/api/v1/auth/employee/verify-otp').send({
      company,
      mobile,
      code,
      deviceFingerprint: 'device-fingerprint-B',
      deviceLabel: 'Safari on iPhone',
    });
    expect(loginB.status).toBe(403);
    expect(loginB.body.error.code).toBe('DEVICE_RESTRICTED');

    // 5. HR resets the registered device
    const resetRes = await hr.post(`/hr/employees/${worker.id}/reset-device`);
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.reset).toBe(true);

    // 6. Now Device B can successfully register and log in
    await sys(db, (x) =>
      x('otp_challenges').update({ created_at: x.raw("created_at - interval '1 minute'") }),
    );
    await request(app).post('/api/v1/auth/employee/request-otp').send({ company, mobile });
    code = sms.lastCodeFor(`+91${mobile}`);

    const loginBRetry = await request(app).post('/api/v1/auth/employee/verify-otp').send({
      company,
      mobile,
      code,
      deviceFingerprint: 'device-fingerprint-B',
      deviceLabel: 'Safari on iPhone',
    });
    expect(loginBRetry.status).toBe(200);
    workerToken = loginBRetry.body.accessToken;
  });

  it('Employee can submit and HR approve a Profile Update Request (§7.2)', async () => {
    const workerApi = api(workerToken);

    // Employee submits profile change
    const submitRes = await workerApi.post('/me/profile-requests', {
      changes: {
        emergencyContactName: 'Updated Emergency Contact Person',
      },
      reason: 'Updated contact after family relocation',
    });
    expect(submitRes.status).toBe(201);
    expect(submitRes.body.status).toBe('pending');
    const reqId = submitRes.body.id;

    // HR reviews and approves
    const approveRes = await hr.post(`/hr/profile-requests/${reqId}/decide`, {
      status: 'approved',
      decisionComment: 'Verified with employee',
    });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('approved');

    // Verify employee record was updated
    const empRes = await hr.get(`/hr/employees/${worker.id}`);
    expect(empRes.body.emergencyContact?.name || empRes.body.emergencyContactName).toBe(
      'Updated Emergency Contact Person',
    );
  });

  it('Employee can submit and Manager/HR approve a Shift Change Request (§8.2)', async () => {
    const workerApi = api(workerToken);

    // Employee views current shift
    const currentShiftRes = await workerApi.get('/me/shift-requests/current');
    expect(currentShiftRes.status).toBe(200);

    // Employee submits permanent shift change request
    const reqRes = await workerApi.post('/me/shift-requests', {
      requestType: 'permanent',
      requestedShiftId: nightShift.id,
      reason: 'Swapping to night shift rotation',
    });
    expect(reqRes.status).toBe(201);
    expect(reqRes.body.requestType).toBe('permanent');
    expect(reqRes.body.status).toBe('pending');
    const shiftReqId = reqRes.body.id;

    // HR approves the shift change
    const approveRes = await hr.post(`/shift-requests/${shiftReqId}/decide`, {
      status: 'approved',
      decisionComment: 'Approved for night rotation',
    });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('approved');

    // Verify employee record has new shift assigned
    const empRes = await hr.get(`/hr/employees/${worker.id}`);
    expect(empRes.body.shift?.id).toBe(nightShift.id);
  });
});
