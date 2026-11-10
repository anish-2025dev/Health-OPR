import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addUser, bearer, createTenant, login, setupTestApp, sys } from './helpers.js';
import { addDays, dayOfWeek, localParts } from '../../src/modules/hr-attendance/calc.js';

const { app, db, sms } = setupTestApp();
const today = localParts(Date.now(), 'Asia/Kolkata').date;
const year = Number(today.slice(0, 4));
/** Next date on or after `from` that is not a Sunday (the test employees' week off). */
const workday = (from) => (dayOfWeek(from) === 0 ? addDays(from, 1) : from);

let t;
let other;
let hr;
let receptionist;
let manager;
let worker;
let workerApi;
let managerApi;
const types = {};

const api = (token) => ({
  get: (url) => request(app).get(`/api/v1${url}`).set(bearer(token)),
  post: (url, body = {}) => request(app).post(`/api/v1${url}`).set(bearer(token)).send(body),
  put: (url, body) => request(app).put(`/api/v1${url}`).set(bearer(token)).send(body),
  patch: (url, body) => request(app).patch(`/api/v1${url}`).set(bearer(token)).send(body),
});

async function employeeToken(company, mobile) {
  await sys(db, (x) =>
    x('otp_challenges').update({ created_at: x.raw("created_at - interval '1 minute'") }),
  );
  await request(app).post('/api/v1/auth/employee/request-otp').send({ company, mobile });
  const res = await request(app)
    .post('/api/v1/auth/employee/verify-otp')
    .send({ company, mobile, code: sms.lastCodeFor(`+91${mobile}`) });
  return res.body.accessToken;
}

beforeAll(async () => {
  t = await createTenant(db, 'lv');
  other = await createTenant(db, 'lvb');
  hr = api(
    (await login(app, (await addUser(db, t.organization.id, ['hr_manager'], 'hr')).email)).token,
  );
  receptionist = api(
    (await login(app, (await addUser(db, t.organization.id, ['receptionist'], 'rec')).email)).token,
  );
  manager = (
    await hr.post('/hr/employees', {
      fullName: 'Mona Manager',
      mobile: '9200000001',
      branchId: t.branch.id,
      joiningDate: `${year}-01-01`,
    })
  ).body;
  worker = (
    await hr.post('/hr/employees', {
      fullName: 'Wendy Worker',
      mobile: '9200000002',
      branchId: t.branch.id,
      joiningDate: `${year}-01-01`,
      reportingManagerId: manager.id,
    })
  ).body;
  workerApi = api(await employeeToken(t.organization.slug, '9200000002'));
  managerApi = api(await employeeToken(t.organization.slug, '9200000001'));
});
afterAll(() => db.destroy());

describe('leave types', () => {
  it('HR defines leave types; employees can see them', async () => {
    const cl = await hr.post('/leave/types', {
      name: 'Casual Leave',
      code: 'cl',
      annualQuota: 12,
      accrual: 'yearly_upfront',
      maxConsecutiveDays: 3,
    });
    expect(cl.status).toBe(201);
    expect(cl.body.code).toBe('CL');
    types.cl = cl.body;
    types.el = (
      await hr.post('/leave/types', {
        name: 'Earned Leave',
        code: 'EL',
        annualQuota: 15,
        approvalLevels: 2,
        minNoticeDays: 7,
        allowHalfDay: false,
        carryForwardMax: 5,
      })
    ).body;
    types.lop = (
      await hr.post('/leave/types', {
        name: 'Loss of Pay',
        code: 'LOP',
        isPaid: false,
        annualQuota: 0,
        accrual: 'none',
      })
    ).body;
    expect((await hr.post('/leave/types', { name: 'Dup', code: 'CL' })).status).toBe(409);
    expect((await receptionist.post('/leave/types', { name: 'X', code: 'X' })).status).toBe(403);
    const list = await workerApi.get('/leave/types');
    expect(list.body.data.map((x) => x.code)).toEqual(['CL', 'EL', 'LOP']);
  });

  it('shows balances: quota, unpaid leave unlimited', async () => {
    const b = await workerApi.get('/me/leave/balances');
    expect(b.status).toBe(200);
    const byCode = Object.fromEntries(b.body.balances.map((x) => [x.type.code, x]));
    expect(byCode.CL).toMatchObject({ accrued: 12, used: 0, pending: 0, available: 12 });
    expect(byCode.LOP.available).toBeNull();
  });
});

describe('applying for leave', () => {
  const start = workday(addDays(today, 10));

  it('validates: max days, half days, notice, week offs, insufficient balance', async () => {
    const long = await workerApi.post('/me/leave/requests', {
      leaveTypeId: types.cl.id,
      startDate: start,
      endDate: addDays(start, 6),
      reason: 'Trip',
    });
    expect(long.status).toBe(400);
    expect(long.body.error.code).toBe('TOO_MANY_DAYS');
    const half = await workerApi.post('/me/leave/requests', {
      leaveTypeId: types.el.id,
      startDate: addDays(today, 20),
      endDate: addDays(today, 20),
      startHalf: true,
      reason: 'x reason',
    });
    expect(half.status).toBe(400);
    const notice = await workerApi.post('/me/leave/requests', {
      leaveTypeId: types.el.id,
      startDate: workday(addDays(today, 1)),
      endDate: workday(addDays(today, 1)),
      reason: 'Short notice',
    });
    expect(notice.body.error.code).toBe('NOTICE_TOO_SHORT');
    let sunday = addDays(today, 3);
    while (dayOfWeek(sunday) !== 0) sunday = addDays(sunday, 1);
    const off = await workerApi.post('/me/leave/requests', {
      leaveTypeId: types.cl.id,
      startDate: sunday,
      endDate: sunday,
      reason: 'Sunday',
    });
    expect(off.body.error.code).toBe('NO_WORKING_DAYS');
  });

  it('previews days and applies; overlapping leave is refused', async () => {
    const preview = await workerApi.post('/me/leave/preview', {
      leaveTypeId: types.cl.id,
      startDate: start,
      endDate: start,
      startHalf: true,
    });
    expect(preview.body).toMatchObject({ days: 0.5, balanceAfter: 11.5 });
    const res = await workerApi.post('/me/leave/requests', {
      leaveTypeId: types.cl.id,
      startDate: start,
      endDate: start,
      reason: 'Family function',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending', days: 1, approvalLevel: 1 });
    types.firstRequest = res.body.id;
    const overlap = await workerApi.post('/me/leave/requests', {
      leaveTypeId: types.lop.id,
      startDate: start,
      endDate: start,
      reason: 'Again',
    });
    expect(overlap.status).toBe(409);
    const b = await workerApi.get('/me/leave/balances');
    expect(b.body.balances.find((x) => x.type.code === 'CL')).toMatchObject({
      pending: 1,
      available: 11,
    });
  });

  it('refuses more than the balance for paid leave, but unpaid leave is unlimited', async () => {
    await hr.post('/leave/adjustments', {
      employeeId: worker.id,
      leaveTypeId: types.cl.id,
      year,
      days: -10.5,
      reason: 'Used before go-live',
    });
    const b = await workerApi.get('/me/leave/balances');
    expect(b.body.balances.find((x) => x.type.code === 'CL').available).toBe(0.5);
    const next = workday(addDays(start, 3));
    const tooMuch = await workerApi.post('/me/leave/requests', {
      leaveTypeId: types.cl.id,
      startDate: next,
      endDate: next,
      reason: 'More leave',
    });
    expect(tooMuch.body.error.code).toBe('INSUFFICIENT_BALANCE');
    const unpaid = await workerApi.post('/me/leave/requests', {
      leaveTypeId: types.lop.id,
      startDate: next,
      endDate: next,
      reason: 'Personal work',
    });
    expect(unpaid.status).toBe(201);
    types.unpaidRequest = unpaid.body.id;
  });
});

describe('approvals', () => {
  it('the reporting manager approves a 1-level leave; the employee cannot approve their own', async () => {
    expect((await workerApi.post(`/leave/requests/${types.firstRequest}/approve`)).status).toBe(
      404,
    );
    const list = await managerApi.get('/leave/requests?status=pending');
    const mine = list.body.data.find((r) => r.id === types.firstRequest);
    expect(mine.canDecide).toBe(true);
    const ok = await managerApi.post(`/leave/requests/${types.firstRequest}/approve`, {
      comment: 'Enjoy',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
    expect((await managerApi.post(`/leave/requests/${types.firstRequest}/approve`)).status).toBe(
      409,
    );
  });

  it('approved leave appears on attendance and in the register', async () => {
    const start = workday(addDays(today, 10));
    const month = await workerApi.get(`/me/attendance?month=${start.slice(0, 7)}`);
    const day = month.body.days.find((d) => d.date === start);
    expect(day.status).toBe('leave');
    expect(day.leave).toMatchObject({ typeName: 'Casual Leave', isPaid: true, fraction: 1 });
    expect(month.body.summary.paidLeaveDays).toBeGreaterThanOrEqual(1);
    const reg = await hr.get(`/attendance/register?date=${start}`);
    expect(reg.body.data.find((r) => r.employee.id === worker.id).day.status).toBe('leave');
  });

  it('two-level leave: manager first, then HR', async () => {
    const start = workday(addDays(today, 15));
    const res = await workerApi.post('/me/leave/requests', {
      leaveTypeId: types.el.id,
      startDate: start,
      endDate: start,
      reason: 'Wedding',
    });
    expect(res.status).toBe(201);
    const first = await managerApi.post(`/leave/requests/${res.body.id}/approve`);
    expect(first.body).toMatchObject({
      status: 'pending',
      approvalLevel: 2,
      level1By: 'Mona Manager',
    });
    // Level 2 is HR only.
    expect((await managerApi.post(`/leave/requests/${res.body.id}/approve`)).status).toBe(404);
    const final = await hr.post(`/leave/requests/${res.body.id}/approve`);
    expect(final.body.status).toBe('approved');
  });

  it('rejecting needs a reason', async () => {
    expect(
      (await managerApi.post(`/leave/requests/${types.unpaidRequest}/reject`, {})).status,
    ).toBe(400);
    const rejected = await managerApi.post(`/leave/requests/${types.unpaidRequest}/reject`, {
      comment: 'Busy week',
    });
    expect(rejected.body).toMatchObject({ status: 'rejected', decisionComment: 'Busy week' });
  });
});

describe('cancelling', () => {
  it('employee cancels pending or future approved leave; HR cancels anything with a reason', async () => {
    const cancel = await workerApi.post(`/me/leave/requests/${types.firstRequest}/cancel`);
    expect(cancel.body.status).toBe('cancelled');
    const start = workday(addDays(today, 10));
    const month = await workerApi.get(`/me/attendance?month=${start.slice(0, 7)}`);
    expect(month.body.days.find((d) => d.date === start).status).not.toBe('leave');

    // A past approved leave (inserted directly as history) can't be cancelled by the employee.
    const past = workday(addDays(today, -5));
    const [row] = await sys(db, (x) =>
      x('leave_requests')
        .insert({
          organization_id: t.organization.id,
          employee_id: worker.id,
          leave_type_id: types.lop.id,
          start_date: past,
          end_date: past,
          days: 1,
          leave_year: year,
          reason: 'Past leave',
          status: 'approved',
        })
        .returning('id'),
    );
    expect((await workerApi.post(`/me/leave/requests/${row.id}/cancel`)).status).toBe(409);
    expect((await hr.post(`/leave/requests/${row.id}/cancel`, {})).status).toBe(400);
    expect(
      (await hr.post(`/leave/requests/${row.id}/cancel`, { comment: 'Entered by mistake' })).body
        .status,
    ).toBe('cancelled');
  });
});

describe('balances, carry forward, export', () => {
  it("HR sees everyone's balances and can carry forward unused leave once", async () => {
    const res = await hr.get(`/leave/balances?year=${year}`);
    expect(res.status).toBe(200);
    const w = res.body.data.find((x) => x.employee.id === worker.id);
    expect(w.balances.find((b) => b.type.code === 'EL')).toMatchObject({ used: 1, available: 14 });
    const cf = await hr.post('/leave/carry-forward', { fromYear: year });
    expect(cf.body.entries).toBeGreaterThanOrEqual(2);
    const again = await hr.post('/leave/carry-forward', { fromYear: year });
    expect(again.body.entries).toBe(0);
    const next = await workerApi.get(`/me/leave/balances?year=${year + 1}`);
    expect(next.body.balances.find((b) => b.type.code === 'EL').adjusted).toBe(5);
  });

  it('exports approved leave as CSV', async () => {
    const res = await hr.get(`/leave/export?year=${year}`);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('Earned Leave');
  });

  it('roles and tenants are isolated', async () => {
    expect((await receptionist.get('/leave/balances')).status).toBe(403);
    expect((await receptionist.get('/leave/requests')).status).toBe(403);
    const otherOwner = api((await login(app, other.owner.email)).token);
    const list = await otherOwner.get('/leave/requests?status=all');
    expect(list.body.data.some((r) => r.employee.id === worker.id)).toBe(false);
    const any = (await hr.get('/leave/requests?status=all')).body.data[0];
    expect(
      (await otherOwner.post(`/leave/requests/${any.id}/cancel`, { comment: 'cross tenant' }))
        .status,
    ).toBe(404);
    expect(
      (
        await otherOwner.post('/leave/adjustments', {
          employeeId: worker.id,
          leaveTypeId: types.cl.id,
          year,
          days: 5,
          reason: 'cross tenant',
        })
      ).status,
    ).toBe(404);
  });
});
