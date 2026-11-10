import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addUser, bearer, createTenant, login, setupTestApp, sys } from './helpers.js';
import { addDays, dayOfWeek, zonedToUtc } from '../../src/modules/hr-attendance/calc.js';

const { app, db, sms } = setupTestApp();
const MONTH = '2026-10';
let t;
let other;
let owner;
let payroll;
let receptionist;
let worker;
let colleague;
let workerApi;
let colleagueApi;
const c = {};
let runId;
let itemId;

const api = (token) => ({
  get: (url) => request(app).get(`/api/v1${url}`).set(bearer(token)),
  post: (url, body = {}) => request(app).post(`/api/v1${url}`).set(bearer(token)).send(body),
  put: (url, body) => request(app).put(`/api/v1${url}`).set(bearer(token)).send(body),
  patch: (url, body) => request(app).patch(`/api/v1${url}`).set(bearer(token)).send(body),
  del: (url) => request(app).delete(`/api/v1${url}`).set(bearer(token)),
});
const binary = (req) =>
  req.buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
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

/** Seeds October 2026: present every working day except an absence on 5th and a half day on 6th; two late days. */
async function seedOctober(employeeId, branchId) {
  const rows = [];
  for (let d = `${MONTH}-01`; d <= `${MONTH}-31`; d = addDays(d, 1)) {
    if (dayOfWeek(d) === 0 || d === '2026-10-05') continue;
    const half = d === '2026-10-06';
    const late = d === '2026-10-07' || d === '2026-10-08';
    rows.push({
      organization_id: t.organization.id,
      employee_id: employeeId,
      branch_id: branchId,
      work_date: d,
      first_in: zonedToUtc(d, late ? '09:40' : '09:00', 'Asia/Kolkata'),
      last_out: zonedToUtc(d, half ? '15:00' : '18:30', 'Asia/Kolkata'),
      worked_minutes: half ? 360 : 570,
      is_late: late,
      late_minutes: late ? 40 : 0,
      status: half ? 'half_day' : 'present',
    });
  }
  await sys(db, (x) => x('attendance_days').insert(rows));
}

beforeAll(async () => {
  t = await createTenant(db, 'pay');
  other = await createTenant(db, 'payb');
  owner = api((await login(app, t.owner.email)).token);
  payroll = api(
    (await login(app, (await addUser(db, t.organization.id, ['payroll_manager'], 'pm')).email))
      .token,
  );
  receptionist = api(
    (await login(app, (await addUser(db, t.organization.id, ['receptionist'], 'rec')).email)).token,
  );
  worker = (
    await owner.post('/hr/employees', {
      fullName: 'Pooja Payee',
      mobile: '9300000001',
      branchId: t.branch.id,
      joiningDate: '2026-01-01',
    })
  ).body;
  colleague = (
    await owner.post('/hr/employees', {
      fullName: 'Cyrus Colleague',
      mobile: '9300000002',
      branchId: t.branch.id,
      joiningDate: '2026-01-01',
    })
  ).body;
  await seedOctober(worker.id, t.branch.id);
  await owner.put('/attendance/policy', {
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
  workerApi = api(await employeeToken(t.organization.slug, '9300000001'));
  colleagueApi = api(await employeeToken(t.organization.slug, '9300000002'));
});
afterAll(() => db.destroy());

describe('setup: settings, components, structures, policies', () => {
  it('day-rate settings', async () => {
    expect((await payroll.get('/payroll/settings')).body.dayRateBasis).toBe('calendar_days');
    const bad = await payroll.put('/payroll/settings', {
      dayRateBasis: 'fixed_days',
      incompleteDayLop: 1,
      reducedHoursLop: 0.5,
    });
    expect(bad.status).toBe(400);
  });

  it('components: fixed and percentage', async () => {
    c.basic = (
      await payroll.post('/payroll/components', {
        name: 'Basic',
        code: 'basic',
        kind: 'earning',
        displayOrder: 1,
      })
    ).body;
    c.hra = (
      await payroll.post('/payroll/components', {
        name: 'House rent allowance',
        code: 'HRA',
        kind: 'earning',
        calc: 'percent_of_component',
        percent: '40',
        baseComponentId: c.basic.id,
        displayOrder: 2,
      })
    ).body;
    c.conv = (
      await payroll.post('/payroll/components', {
        name: 'Conveyance',
        code: 'CONV',
        kind: 'earning',
        includeInDayRate: false,
        displayOrder: 3,
      })
    ).body;
    expect(c.basic.code).toBe('BASIC');
    expect(c.hra).toMatchObject({ calc: 'percent_of_component', percent: '40' });
    const nested = await payroll.post('/payroll/components', {
      name: 'Bad',
      code: 'BAD',
      kind: 'earning',
      calc: 'percent_of_component',
      percent: '10',
      baseComponentId: c.hra.id,
    });
    expect(nested.status).toBe(400);
    expect(
      (await payroll.post('/payroll/components', { name: 'Dup', code: 'BASIC', kind: 'earning' }))
        .status,
    ).toBe(409);
  });

  it('salary structures are effective-dated; revisions close the previous one', async () => {
    const pct = await payroll.post('/payroll/structures', {
      employeeId: worker.id,
      effectiveFrom: '2026-01-01',
      lines: [{ componentId: c.hra.id, amount: '100' }],
    });
    expect(pct.status).toBe(400);
    const first = await payroll.post('/payroll/structures', {
      employeeId: worker.id,
      effectiveFrom: '2026-01-01',
      lines: [
        { componentId: c.basic.id, amount: '18000' },
        { componentId: c.conv.id, amount: '1600' },
      ],
    });
    expect(first.status).toBe(201);
    const revision = await payroll.post('/payroll/structures', {
      employeeId: worker.id,
      effectiveFrom: '2026-09-01',
      note: 'Annual increment',
      lines: [
        { componentId: c.basic.id, amount: '20000' },
        { componentId: c.conv.id, amount: '1600' },
      ],
    });
    expect(revision.status).toBe(201);
    const history = await payroll.get(`/payroll/structures/${worker.id}/history`);
    expect(history.body.data.map((s) => [s.effectiveFrom, s.effectiveTo])).toEqual([
      ['2026-09-01', null],
      ['2026-01-01', '2026-08-31'],
    ]);
    const backdated = await payroll.post('/payroll/structures', {
      employeeId: worker.id,
      effectiveFrom: '2026-05-01',
      lines: [{ componentId: c.basic.id, amount: '1' }],
    });
    expect(backdated.status).toBe(409);
  });

  it('company pay policies', async () => {
    const canteen = await payroll.post('/payroll/policies', {
      name: 'Canteen',
      code: 'CANTEEN',
      kind: 'deduction',
      calc: 'fixed',
      amount: '500',
      effectiveFrom: '2026-01-01',
    });
    expect(canteen.status).toBe(201);
    const advance = await payroll.post('/payroll/policies', {
      name: 'Salary advance',
      code: 'ADV',
      kind: 'deduction',
      calc: 'fixed',
      amount: '1000',
      frequency: 'installments',
      installments: 2,
      appliesTo: 'employees',
      appliesToIds: [worker.id],
      effectiveFrom: '2026-10-01',
    });
    expect(advance.status).toBe(201);
    const invalid = await payroll.post('/payroll/policies', {
      name: 'OT',
      code: 'OT',
      kind: 'earning',
      calc: 'per_unit',
      effectiveFrom: '2026-01-01',
    });
    expect(invalid.status).toBe(400);
  });
});

describe('payroll run', () => {
  it('creates one run per month and calculates from attendance', async () => {
    const run = await payroll.post('/payroll/runs', { month: MONTH });
    expect(run.status).toBe(201);
    runId = run.body.id;
    expect((await payroll.post('/payroll/runs', { month: MONTH })).status).toBe(409);
    const calc = await payroll.post(`/payroll/runs/${runId}/calculate`);
    expect(calc.status).toBe(200);
    expect(calc.body.employees).toBe(1);
    expect(
      calc.body.warnings.some(
        (w) => w.code === 'NO_SALARY_STRUCTURE' && w.employeeId === colleague.id,
      ),
    ).toBe(true);
  });

  it('computes exact amounts: structure, LOP, late penalty, policies, instalments', async () => {
    const res = await payroll.get(`/payroll/runs/${runId}`);
    const item = res.body.items[0];
    itemId = item.id;
    const amount = (code) => item.lines.find((l) => l.code === code)?.amount;
    expect(amount('BASIC')).toBe('20000.00');
    expect(amount('HRA')).toBe('8000.00');
    expect(amount('CONV')).toBe('1600.00');
    // 1 absent + 0.5 half day = 1.5 LOP days; day rate base 28000 (Conveyance excluded) / 31 days
    expect(item.metrics.lopDays).toBe(1.5);
    expect(amount('LOP')).toBe('1354.84');
    expect(amount('LATE')).toBe('100.00');
    expect(amount('CANTEEN')).toBe('500.00');
    expect(item.lines.find((l) => l.code === 'ADV').label).toBe('Salary advance (1 of 2)');
    expect(item.grossEarnings).toBe('29600.00');
    expect(item.totalDeductions).toBe('2954.84');
    expect(item.netPay).toBe('26645.16');
  });

  it('is reproducible from the stored snapshot', async () => {
    const v = await payroll.get(`/payroll/runs/${runId}/items/${itemId}/verify`);
    expect(v.body.reproducible).toBe(true);
  });

  it('adjustments make the run stale until recalculated', async () => {
    const adj = await payroll.post(`/payroll/runs/${runId}/adjustments`, {
      employeeId: worker.id,
      kind: 'earning',
      label: 'Festival bonus',
      amount: '1000',
      reason: 'Diwali bonus',
    });
    expect(adj.body.status).toBe('draft');
    expect(
      (await owner.post(`/payroll/runs/${runId}/approve`, { confirm: true })).body.error.code,
    ).toBe('NOT_CALCULATED');
    await payroll.post(`/payroll/runs/${runId}/calculate`);
    const item = (await payroll.get(`/payroll/runs/${runId}`)).body.items[0];
    itemId = item.id;
    expect(item.netPay).toBe('27645.16');
  });

  it('only an approver can approve, and only with explicit confirmation', async () => {
    expect((await payroll.post(`/payroll/runs/${runId}/approve`, { confirm: true })).status).toBe(
      403,
    );
    expect((await owner.post(`/payroll/runs/${runId}/approve`, {})).status).toBe(400);
    const ok = await owner.post(`/payroll/runs/${runId}/approve`, { confirm: true });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
  });
});

describe('approved payroll is immutable', () => {
  it('rejects recalculation, adjustments and deletion through the API', async () => {
    expect((await payroll.post(`/payroll/runs/${runId}/calculate`)).status).toBe(409);
    expect(
      (
        await payroll.post(`/payroll/runs/${runId}/adjustments`, {
          employeeId: worker.id,
          kind: 'earning',
          label: 'More',
          amount: '1',
          reason: 'late add',
        })
      ).status,
    ).toBe(409);
    expect((await payroll.del(`/payroll/runs/${runId}`)).status).toBe(409);
  });

  it('the database itself rejects edits to approved items and runs', async () => {
    await expect(
      sys(db, (x) => x('payroll_items').where({ id: itemId }).update({ net_pay: '1.00' })),
    ).rejects.toThrow(/immutable/);
    await expect(sys(db, (x) => x('payroll_items').where({ id: itemId }).delete())).rejects.toThrow(
      /immutable/,
    );
    await expect(
      sys(db, (x) => x('payroll_runs').where({ id: runId }).update({ status: 'draft' })),
    ).rejects.toThrow(/immutable/);
  });

  it('locks attendance and leave for the approved period', async () => {
    const edit = await owner.put(`/attendance/employees/${worker.id}/days/2026-10-05`, {
      status: 'present',
      reason: 'Late correction',
    });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('PAYROLL_LOCKED');
  });

  it('records payments without changing amounts (separate permission)', async () => {
    expect(
      (
        await workerApi.post(`/payroll/runs/${runId}/payments`, {
          itemIds: [itemId],
          status: 'paid',
        })
      ).status,
    ).toBe(403);
    const paid = await payroll.post(`/payroll/runs/${runId}/payments`, {
      itemIds: [itemId],
      status: 'paid',
      reference: 'NEFT-OCT-01',
    });
    expect(paid.body.updated).toBe(1);
    const v = await payroll.get(`/payroll/runs/${runId}/items/${itemId}/verify`);
    expect(v.body.reproducible).toBe(true);
  });

  it('continues instalments in the next month', async () => {
    const nov = (await payroll.post('/payroll/runs', { month: '2026-11' })).body;
    await payroll.post(`/payroll/runs/${nov.id}/calculate`);
    const item = (await payroll.get(`/payroll/runs/${nov.id}`)).body.items[0];
    expect(item.lines.find((l) => l.code === 'ADV').label).toBe('Salary advance (2 of 2)');
  });
});

describe('payslips', () => {
  it('employees download only their own approved payslips', async () => {
    const list = await workerApi.get('/me/payslips');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      netPay: '27645.16',
      paymentStatus: 'paid',
      period: { label: 'October 2026' },
    });
    const pdf = await binary(workerApi.get(`/me/payslips/${itemId}/pdf`));
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    expect((await colleagueApi.get(`/me/payslips/${itemId}/pdf`)).status).toBe(404);
    expect((await colleagueApi.get('/me/payslips')).body.data).toHaveLength(0);
  });

  it('admins download one payslip, all as a ZIP, and the CSV register', async () => {
    const one = await binary(payroll.get(`/payroll/runs/${runId}/items/${itemId}/payslip.pdf`));
    expect(one.body.subarray(0, 4).toString()).toBe('%PDF');
    const zip = await binary(payroll.get(`/payroll/runs/${runId}/payslips.zip`));
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.body.subarray(0, 2).toString()).toBe('PK');
    const csv = await payroll.get(`/payroll/runs/${runId}/export.csv`);
    expect(csv.text).toContain('27645.16');
    expect(csv.text).toContain('NEFT-OCT-01');
  });
});

describe('access control', () => {
  it('non-payroll roles and other tenants have no access', async () => {
    expect((await receptionist.get('/payroll/runs')).status).toBe(403);
    expect((await workerApi.get('/payroll/runs')).status).toBe(403);
    const otherOwner = api((await login(app, other.owner.email)).token);
    expect((await otherOwner.get(`/payroll/runs/${runId}`)).status).toBe(404);
    expect(
      (await otherOwner.get(`/payroll/runs/${runId}/items/${itemId}/payslip.pdf`)).status,
    ).toBe(404);
    expect((await otherOwner.get('/payroll/runs')).body.data).toEqual([]);
    expect(
      (
        await otherOwner.post('/payroll/structures', {
          employeeId: worker.id,
          effectiveFrom: '2027-01-01',
          lines: [{ componentId: c.basic.id, amount: '1' }],
        })
      ).status,
    ).toBe(404);
  });
});
