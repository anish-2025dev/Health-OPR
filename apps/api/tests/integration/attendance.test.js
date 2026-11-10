import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { CSRF, addUser, bearer, createTenant, login, setupTestApp, sys } from './helpers.js';
import { localParts, addDays } from '../../src/modules/hr-attendance/calc.js';

const { app, db, sms } = setupTestApp();
const TZ = 'Asia/Kolkata';
const BRANCH_POINT = { latitude: 12.9716, longitude: 77.5946 };
const INSIDE = { latitude: 12.97163, longitude: 77.5946, accuracy: 8 }; // ~3 m away
const OUTSIDE = { latitude: 12.9736, longitude: 77.5946, accuracy: 8 }; // ~220 m away

const today = localParts(Date.now(), TZ).date;
const yesterday = addDays(today, -1);
const month = today.slice(0, 7);

let t; // tenant A
let other; // tenant B
let owner;
let hr;
let receptionist;
let manager; // employee record
let worker; // employee record, reports to manager
let workerToken;
let managerToken;

const api = (token) => ({
  get: (url) => request(app).get(`/api/v1${url}`).set(bearer(token)),
  post: (url, body) => request(app).post(`/api/v1${url}`).set(bearer(token)).send(body),
  put: (url, body) => request(app).put(`/api/v1${url}`).set(bearer(token)).send(body),
  patch: (url, body) => request(app).patch(`/api/v1${url}`).set(bearer(token)).send(body),
});

/** OTP rules allow one code per 30 s; tests move earlier codes back in time instead of waiting. */
const skipCooldown = () =>
  sys(db, (x) =>
    x('otp_challenges').update({ created_at: x.raw("created_at - interval '1 minute'") }),
  );
/** The 60-second minimum gap between punches, likewise. */
const agePunches = () =>
  sys(db, (x) =>
    x('attendance_punches').update({ punched_at: x.raw("punched_at - interval '2 minutes'") }),
  );

async function employeeLogin(company, mobile) {
  await skipCooldown();
  const req = await request(app)
    .post('/api/v1/auth/employee/request-otp')
    .send({ company, mobile });
  expect(req.status).toBe(202);
  const code = sms.lastCodeFor(mobile);
  const res = await request(app)
    .post('/api/v1/auth/employee/verify-otp')
    .send({ company, mobile, code });
  expect(res.status).toBe(200);
  return res.body.accessToken;
}

async function markAttendance(token, position = INSIDE) {
  await skipCooldown();
  await agePunches();
  const start = await api(token).post('/me/attendance/start', position);
  if (start.status !== 201) return start;
  const mobile = sms.sent.at(-1).to;
  return api(token).post('/me/attendance/confirm', {
    challengeId: start.body.challengeId,
    code: sms.lastCodeFor(mobile),
  });
}

beforeAll(async () => {
  t = await createTenant(db, 'att');
  other = await createTenant(db, 'attb');
  owner = api((await login(app, t.owner.email)).token);
  hr = api(
    (await login(app, (await addUser(db, t.organization.id, ['hr_manager'], 'hr')).email)).token,
  );
  receptionist = api(
    (await login(app, (await addUser(db, t.organization.id, ['receptionist'], 'rec')).email)).token,
  );

  await owner.patch(`/branches/${t.branch.id}`, { location: BRANCH_POINT, geofenceRadiusM: 10 });
  const shift = (
    await hr.post('/shifts', {
      name: 'General',
      startTime: '09:00',
      endTime: '18:00',
      breakMinutes: 60,
    })
  ).body;
  manager = (
    await hr.post('/hr/employees', {
      fullName: 'Meena Manager',
      mobile: '9100000001',
      branchId: t.branch.id,
      shiftId: shift.id,
      joiningDate: '2026-01-01',
      weeklyOffDays: [],
    })
  ).body;
  worker = (
    await hr.post('/hr/employees', {
      fullName: 'Wasim Worker',
      mobile: '9100000002',
      branchId: t.branch.id,
      shiftId: shift.id,
      reportingManagerId: manager.id,
      joiningDate: '2026-01-01',
      weeklyOffDays: [],
    })
  ).body;
});
afterAll(() => db.destroy());

describe('employee sign-in with mobile + OTP', () => {
  it('responds identically for unknown numbers and sends no SMS', async () => {
    const before = sms.sent.length;
    const res = await request(app)
      .post('/api/v1/auth/employee/request-otp')
      .send({ company: t.organization.slug, mobile: '9199999999' });
    expect(res.status).toBe(202);
    expect(sms.sent.length).toBe(before);
    const wrongCompany = await request(app)
      .post('/api/v1/auth/employee/request-otp')
      .send({ company: 'no-such-company', mobile: '9100000002' });
    expect(wrongCompany.status).toBe(202);
    expect(wrongCompany.body.message).toBe(res.body.message);
    expect(sms.sent.length).toBe(before);
  });

  it('rejects wrong codes and locks the code after 5 wrong attempts', async () => {
    await skipCooldown();
    await request(app)
      .post('/api/v1/auth/employee/request-otp')
      .send({ company: t.organization.slug, mobile: '9100000002' });
    const code = sms.lastCodeFor('+919100000002');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post('/api/v1/auth/employee/verify-otp')
        .send({ company: t.organization.slug, mobile: '9100000002', code: wrong });
      expect(r.status).toBe(400);
    }
    const locked = await request(app)
      .post('/api/v1/auth/employee/verify-otp')
      .send({ company: t.organization.slug, mobile: '9100000002', code });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('OTP_TOO_MANY_ATTEMPTS');
  });

  it('enforces a cooldown between codes', async () => {
    await skipCooldown();
    const body = { company: t.organization.slug, mobile: '9100000002' };
    expect((await request(app).post('/api/v1/auth/employee/request-otp').send(body)).status).toBe(
      202,
    );
    const again = await request(app).post('/api/v1/auth/employee/request-otp').send(body);
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('OTP_COOLDOWN');
  });

  it('signs in, creates an employee-only account, and keeps admin pages closed', async () => {
    workerToken = await employeeLogin(t.organization.slug, '+919100000002');
    const me = await api(workerToken).get('/auth/me');
    expect(me.body.employee).toMatchObject({
      id: worker.id,
      employeeNumber: worker.employeeNumber,
    });
    expect(me.body.roles.map((r) => r.role)).toEqual(['employee']);
    expect(me.body.user.email).toBeNull();
    expect((await api(workerToken).get('/hr/employees')).status).toBe(403);
    expect((await api(workerToken).get('/attendance/dashboard')).status).toBe(403);
    // Employee-only logins don't clutter the staff Users page.
    const users = await owner.get('/users');
    expect(users.body.data.some((u) => u.fullName === 'Wasim Worker')).toBe(false);

    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set(CSRF)
      .set('Cookie', 'hos_refresh=invalid');
    expect(refreshed.status).toBe(401);
  });

  it('never opens a staff account with an OTP', async () => {
    const hrUser = await addUser(db, t.organization.id, ['hr_manager'], 'hrlinked');
    await hr.post('/hr/employees', {
      fullName: 'Staff Linked',
      mobile: '9100000009',
      branchId: t.branch.id,
      joiningDate: '2026-01-01',
      userId: hrUser.id,
    });
    await skipCooldown();
    await request(app)
      .post('/api/v1/auth/employee/request-otp')
      .send({ company: t.organization.slug, mobile: '9100000009' });
    const res = await request(app)
      .post('/api/v1/auth/employee/verify-otp')
      .send({
        company: t.organization.slug,
        mobile: '9100000009',
        code: sms.lastCodeFor('+919100000009'),
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('USE_PASSWORD_LOGIN');
  });
});

describe('marking attendance: location first, then OTP', () => {
  it('shows a check-in as the next action', async () => {
    const res = await api(workerToken).get('/me/attendance/today');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      nextAction: 'check_in',
      branch: { locationConfigured: true, radiusM: 10 },
    });
  });

  it('outside the geofence: rejected, no SMS sent, attempt audited', async () => {
    const before = sms.sent.length;
    const res = await markAttendance(workerToken, OUTSIDE);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OUTSIDE_GEOFENCE');
    expect(res.body.error.details.distanceM).toBeGreaterThan(200);
    expect(sms.sent.length).toBe(before);
    const audit = await sys(db, (x) =>
      x('audit_logs')
        .where({ entity_id: worker.id, action: 'attendance.attempt_rejected' })
        .first(),
    );
    expect(audit.reason).toBe('OUTSIDE_GEOFENCE');
  });

  it('imprecise location: rejected even at the right spot', async () => {
    const res = await markAttendance(workerToken, { ...BRANCH_POINT, accuracy: 35 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('LOCATION_TOO_IMPRECISE');
  });

  it('a wrong OTP marks nothing', async () => {
    await skipCooldown();
    const start = await api(workerToken).post('/me/attendance/start', INSIDE);
    expect(start.status).toBe(201);
    expect(start.body.sentTo).toBe('+91 ••••••0002');
    const code = sms.lastCodeFor('+919100000002');
    const wrong = await api(workerToken).post('/me/attendance/confirm', {
      challengeId: start.body.challengeId,
      code: code === '123456' ? '654321' : '123456',
    });
    expect(wrong.status).toBe(400);
    const punches = await sys(db, (x) => x('attendance_punches').where({ employee_id: worker.id }));
    expect(punches).toHaveLength(0);
  });

  it("an employee cannot use another employee's challenge", async () => {
    managerToken = await employeeLogin(t.organization.slug, '+919100000001');
    await skipCooldown();
    const start = await api(workerToken).post('/me/attendance/start', INSIDE);
    const res = await api(managerToken).post('/me/attendance/confirm', {
      challengeId: start.body.challengeId,
      code: sms.lastCodeFor('+919100000002'),
    });
    expect(res.status).toBe(400);
  });

  it('location + correct OTP: check-in recorded', async () => {
    const res = await markAttendance(workerToken);
    expect(res.status).toBe(201);
    expect(res.body.punchType).toBe('in');
    expect(['checked_in', 'present', 'half_day', 'absent', 'reduced_hours']).toContain(
      res.body.day.status,
    );
    expect(res.body.day.checkIn).toMatch(/^\d{2}:\d{2}$/);
    const punch = await sys(db, (x) =>
      x('attendance_punches').where({ employee_id: worker.id }).first(),
    );
    expect(punch).toMatchObject({ source: 'app_otp_geo', punch_type: 'in' });
    expect(Number(punch.distance_m)).toBeLessThanOrEqual(10);
    expect((await api(workerToken).get('/me/attendance/today')).body.nextAction).toBe('check_out');
  });

  it('a second punch within a minute is refused; later it is a check-out', async () => {
    await skipCooldown();
    const start = await api(workerToken).post('/me/attendance/start', INSIDE);
    const tooSoon = await api(workerToken).post('/me/attendance/confirm', {
      challengeId: start.body.challengeId,
      code: sms.lastCodeFor('+919100000002'),
    });
    expect(tooSoon.status).toBe(409);
    expect(tooSoon.body.error.code).toBe('PUNCH_TOO_SOON');

    const out = await markAttendance(workerToken);
    expect(out.status).toBe(201);
    expect(out.body.punchType).toBe('out');
    expect(out.body.day.checkOut).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('HR corrections, policy and monthly view', () => {
  it('manual edits require a reason and are audited', async () => {
    const noReason = await hr.put(`/attendance/employees/${worker.id}/days/${yesterday}`, {
      status: 'present',
    });
    expect(noReason.status).toBe(400);
    const ok = await hr.put(`/attendance/employees/${worker.id}/days/${yesterday}`, {
      checkIn: '09:30',
      checkOut: '18:45',
      reason: 'Phone battery died; confirmed by manager',
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      checkIn: '09:30',
      checkOut: '18:45',
      status: 'present',
      statusSource: 'manual',
      isLate: true,
      lateMinutes: 30,
    });
    const audit = await sys(db, (x) =>
      x('audit_logs').where({ entity_id: worker.id, action: 'attendance.day_edited' }).first(),
    );
    expect(audit.reason).toBe('Phone battery died; confirmed by manager');
    expect(
      (
        await hr.put(`/attendance/employees/${worker.id}/days/${addDays(today, 2)}`, {
          status: 'present',
          reason: 'future day',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(workerToken).put(`/attendance/employees/${worker.id}/days/${yesterday}`, {
          status: 'present',
          reason: 'self edit',
        })
      ).status,
    ).toBe(403);
  });

  it('applies the late penalty from the policy in the monthly view', async () => {
    const policy = await hr.put('/attendance/policy', {
      fullDayMinutes: 540,
      halfDayMinutes: 300,
      belowHalfDayStatus: 'absent',
      lateGraceMinutes: 15,
      lateFreePerMonth: 0,
      latePenaltyMode: 'fixed_amount',
      latePenaltyAmount: '50',
      overtimeAfterMinutes: 30,
      minPunchGapSeconds: 60,
    });
    expect(policy.status).toBe(200);
    const bad = await hr.put('/attendance/policy', {
      ...policy.body,
      updatedAt: undefined,
      latePenaltyMode: 'half_day_per_n',
      latePenaltyEveryN: null,
    });
    expect(bad.status).toBe(400);

    const view = await api(workerToken).get(`/me/attendance?month=${yesterday.slice(0, 7)}`);
    expect(view.status).toBe(200);
    const y = view.body.days.find((d) => d.date === yesterday);
    expect(y).toMatchObject({ status: 'present', isLate: true });
    expect(view.body.lateEntries.map((l) => l.date)).toContain(yesterday);
    expect(view.body.latePenalty).toMatchObject({
      mode: 'fixed_amount',
      penalizedLates: view.body.summary.late,
    });
    expect(view.body.latePenalty.amount).toBe((view.body.summary.late * 50).toFixed(2));
    expect(view.body.days).toHaveLength(
      Number(new Date(Date.UTC(...yesterday.slice(0, 7).split('-').map(Number), 0)).getUTCDate()),
    );
  });
});

describe('regularization requests', () => {
  let requestId;

  it('employee requests a correction; duplicates are refused', async () => {
    const twoDaysAgo = addDays(today, -2);
    const res = await api(workerToken).post('/me/attendance/regularizations', {
      date: twoDaysAgo,
      checkIn: '09:05',
      checkOut: '18:10',
      reason: 'Forgot to mark attendance',
    });
    expect(res.status).toBe(201);
    requestId = res.body.id;
    const dup = await api(workerToken).post('/me/attendance/regularizations', {
      date: twoDaysAgo,
      status: 'present',
      reason: 'Again please',
    });
    expect(dup.status).toBe(409);
    const future = await api(workerToken).post('/me/attendance/regularizations', {
      date: addDays(today, 1),
      status: 'present',
      reason: 'Tomorrow',
    });
    expect(future.status).toBe(400);
  });

  it('the reporting manager sees and approves it; the employee cannot approve their own', async () => {
    // Not decidable by the requester: answered like any record outside their access.
    const own = await api(workerToken).post(`/attendance/regularizations/${requestId}/approve`, {});
    expect(own.status).toBe(404);

    const list = await api(managerToken).get('/attendance/regularizations?status=pending');
    expect(list.status).toBe(200);
    expect(list.body.data.map((r) => r.id)).toContain(requestId);

    const rejectNoComment = await api(managerToken).post(
      `/attendance/regularizations/${requestId}/reject`,
      {},
    );
    expect(rejectNoComment.status).toBe(400);

    const ok = await api(managerToken).post(`/attendance/regularizations/${requestId}/approve`, {
      comment: 'OK',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.state).toBe('approved');
    const again = await api(managerToken).post(
      `/attendance/regularizations/${requestId}/approve`,
      {},
    );
    expect(again.status).toBe(409);

    const view = await api(managerToken).get(
      `/attendance/employees/${worker.id}/month?month=${addDays(today, -2).slice(0, 7)}`,
    );
    const day = view.body.days.find((d) => d.date === addDays(today, -2));
    expect(day).toMatchObject({
      checkIn: '09:05',
      checkOut: '18:10',
      statusSource: 'regularization',
      status: 'present',
    });
  });

  it('team view shows direct reports to their manager only', async () => {
    const team = await api(managerToken).get('/attendance/team');
    expect(team.body.data.map((x) => x.employee.id)).toEqual([worker.id]);
    expect((await api(workerToken).get('/attendance/team')).body.data).toEqual([]);
    expect((await api(workerToken).get(`/attendance/employees/${manager.id}/month`)).status).toBe(
      404,
    );
  });
});

describe('dashboard, register and exports', () => {
  it('HR sees today totals, department breakdown and late arrivals', async () => {
    const res = await hr.get('/attendance/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.date).toBe(today);
    expect(res.body.totals.employees).toBeGreaterThanOrEqual(2);
    expect(res.body.totals.checkedIn).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.byDepartment)).toBe(true);
    const register = await hr.get(`/attendance/register?date=${yesterday}`);
    const row = register.body.data.find((r) => r.employee.id === worker.id);
    expect(row.day).toMatchObject({ checkIn: '09:30', isLate: true });
  });

  it('exports attendance as CSV with formula-injection protection', async () => {
    await hr.post('/hr/employees', {
      fullName: '=HYPERLINK("x")',
      mobile: '9100000077',
      branchId: t.branch.id,
      joiningDate: '2026-01-01',
    });
    const res = await hr.get(`/attendance/export?month=${month}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('Employee ID,Name,Department');
    expect(res.text).toContain(worker.employeeNumber);
    expect(res.text).toContain(`"'=HYPERLINK(""x"")"`);
    const holidays = await hr.get(`/attendance/holidays/export?year=${today.slice(0, 4)}`);
    expect(holidays.status).toBe(200);
  });

  it('roles and tenants are isolated', async () => {
    expect((await receptionist.get('/attendance/dashboard')).status).toBe(403);
    expect((await receptionist.get(`/attendance/employees/${worker.id}/month`)).status).toBe(404);
    const otherHr = api((await login(app, other.owner.email)).token);
    expect((await otherHr.get(`/attendance/employees/${worker.id}/month`)).status).toBe(404);
    expect(
      (
        await otherHr.put(`/attendance/employees/${worker.id}/days/${yesterday}`, {
          status: 'absent',
          reason: 'cross tenant',
        })
      ).status,
    ).toBe(404);
    const reg = await otherHr.get('/attendance/register');
    expect(reg.body.data.some((r) => r.employee.id === worker.id)).toBe(false);
  });
});

describe('employee leaves', () => {
  it('marking an employee exited ends their mobile sign-in immediately', async () => {
    await hr.patch(`/hr/employees/${worker.id}`, { employmentStatus: 'exited', exitDate: today });
    expect((await api(workerToken).get('/me/attendance/today')).status).toBe(401);
    const before = sms.sent.length;
    await skipCooldown();
    await request(app)
      .post('/api/v1/auth/employee/request-otp')
      .send({ company: t.organization.slug, mobile: '9100000002' });
    expect(sms.sent.length).toBe(before);
  });
});
