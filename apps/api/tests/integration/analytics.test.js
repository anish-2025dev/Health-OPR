import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addUser, bearer, createTenant, login, setupTestApp, sys } from './helpers.js';

// Fictional data only.
const { app, db } = setupTestApp();
let t;
let other;
let owner;
let hr;
let reception;

const api = (token) => ({ get: (url) => request(app).get(`/api/v1${url}`).set(bearer(token)) });

beforeAll(async () => {
  t = await createTenant(db, 'ana');
  other = await createTenant(db, 'anab');
  owner = api((await login(app, t.owner.email)).token);
  hr = api(
    (await login(app, (await addUser(db, t.organization.id, ['hr_manager'], 'hr')).email)).token,
  );
  reception = api(
    (await login(app, (await addUser(db, t.organization.id, ['receptionist'], 'rc')).email)).token,
  );
  const org = t.organization.id;
  const [dept] = await sys(db, (x) =>
    x('departments').insert({ organization_id: org, name: 'Nursing' }).returning('id'),
  );
  const [e1, e2] = await sys(db, (x) =>
    x('employees')
      .insert(
        [1, 2].map((i) => ({
          organization_id: org,
          employee_number: `A-${i}`,
          full_name: `Analytics ${i}`,
          mobile_e164: `+91985550000${i}`,
          branch_id: t.branch.id,
          department_id: dept.id,
          joining_date: '2026-10-05',
        })),
      )
      .returning('id'),
  );
  const day = (employee, date, status, extra = {}) => ({
    organization_id: org,
    employee_id: employee.id,
    branch_id: t.branch.id,
    work_date: date,
    status,
    worked_minutes: status === 'present' ? 540 : 240,
    ...extra,
  });
  await sys(db, (x) =>
    x('attendance_days').insert([
      day(e1, '2026-10-06', 'present', { is_late: true, late_minutes: 12 }),
      day(e1, '2026-10-07', 'present', { overtime_minutes: 90 }),
      day(e2, '2026-10-06', 'half_day'),
      day(e2, '2026-10-07', 'present', { is_late: true, late_minutes: 5 }),
    ]),
  );
  const [doctor] = await sys(db, (x) =>
    x('doctors')
      .insert({ organization_id: org, branch_id: t.branch.id, display_name: 'Dr. Analytics' })
      .returning('id'),
  );
  const patients = await sys(db, (x) =>
    x('patients')
      .insert(
        [1, 2, 3].map((i) => ({
          organization_id: org,
          patient_number: `AN-${i}`,
          full_name: `Patient ${i}`,
          registration_source: 'reception',
        })),
      )
      .returning('id'),
  );
  const entry = (p, token, status, extra = {}) => ({
    organization_id: org,
    branch_id: t.branch.id,
    doctor_id: doctor.id,
    queue_date: '2026-10-06',
    patient_id: p.id,
    token_number: token,
    kind: 'walk_in',
    status,
    tracking_code: randomUUID().replace(/-/g, '').slice(0, 16),
    ...extra,
  });
  await sys(db, (x) =>
    x('queue_entries').insert([
      entry(patients[0], 1, 'completed', {
        checked_in_at: '2026-10-06T04:00:00Z',
        called_at: '2026-10-06T04:20:00Z',
        started_at: '2026-10-06T04:20:00Z',
        completed_at: '2026-10-06T04:30:00Z',
      }),
      entry(patients[1], 2, 'no_show'),
      entry(patients[2], 3, 'completed', {
        checked_in_at: '2026-10-06T04:10:00Z',
        called_at: '2026-10-06T04:40:00Z',
        started_at: '2026-10-06T04:40:00Z',
        completed_at: '2026-10-06T04:46:00Z',
      }),
    ]),
  );
});
afterAll(() => db.destroy());

describe('workforce analytics', () => {
  it('summarises attendance, lateness, overtime and joiners for a month', async () => {
    const r = await hr.get('/analytics/workforce?month=2026-10');
    expect(r.status).toBe(200);
    expect(r.body.attendance).toMatchObject({
      present: 3,
      halfDay: 1,
      late: 2,
      overtimeHours: 1.5,
    });
    expect(r.body.joiners).toBe(2);
    expect(r.body.byDepartment[0]).toMatchObject({
      department: 'Nursing',
      presentDays: 4,
      late: 2,
    });
    expect(r.body.mostLate).toHaveLength(2);
  });

  it('is limited to HR access', async () => {
    expect((await reception.get('/analytics/workforce?month=2026-10')).status).toBe(403);
  });
});

describe('clinic analytics', () => {
  it('summarises visits, no-shows, waits and arrivals', async () => {
    const r = await reception.get('/analytics/clinic?from=2026-10-01&to=2026-10-31');
    expect(r.body.totals).toMatchObject({
      bookings: 3,
      seen: 2,
      noShows: 1,
      walkIns: 3,
      averageWaitMinutes: 25,
      averageConsultationMinutes: 8,
    });
    expect(r.body.totals.noShowRate).toBeCloseTo(33.3);
    expect(r.body.byDoctor[0]).toMatchObject({ doctor: 'Dr. Analytics', seen: 2 });
    expect(r.body.arrivalsByHour).toEqual([{ hour: 9, arrivals: 2 }]);
  });

  it('HR roles see no clinic analytics; other organizations see nothing', async () => {
    expect((await hr.get('/analytics/clinic?from=2026-10-01&to=2026-10-31')).status).toBe(403);
    const o = api((await login(app, other.owner.email)).token);
    const r = await o.get('/analytics/clinic?from=2026-10-01&to=2026-10-31');
    expect(r.body.totals.bookings).toBe(0);
    const w = await o.get('/analytics/workforce?month=2026-10');
    expect(w.body.attendance.present).toBe(0);
    expect(owner).toBeTruthy();
  });
});
