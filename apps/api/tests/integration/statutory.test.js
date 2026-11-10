import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addUser, bearer, createTenant, login, setupTestApp, sys } from './helpers.js';

// All rule values here are arbitrary fixtures used to check behaviour, NOT statutory rates.
const { app, db } = setupTestApp();
let t;
let other;
let owner;
let payroll;
let worker;
let basic;
const rules = {};

const api = (token) => ({
  get: (url) => request(app).get(`/api/v1${url}`).set(bearer(token)),
  post: (url, body = {}) => request(app).post(`/api/v1${url}`).set(bearer(token)).send(body),
  put: (url, body) => request(app).put(`/api/v1${url}`).set(bearer(token)).send(body),
  del: (url) => request(app).delete(`/api/v1${url}`).set(bearer(token)),
});

const EPF = {
  ruleType: 'epf',
  effectiveFrom: '2026-01-01',
  sourceReference: 'Fixture for tests',
  config: {
    employeeRatePercent: '10',
    employerRatePercent: '11',
    wageComponentCodes: ['BASIC'],
    wageCeiling: null,
    rounding: 'nearest_rupee',
  },
};

beforeAll(async () => {
  t = await createTenant(db, 'stat');
  other = await createTenant(db, 'statb');
  owner = api((await login(app, t.owner.email)).token);
  payroll = api(
    (await login(app, (await addUser(db, t.organization.id, ['payroll_manager'], 'pm')).email))
      .token,
  );
  worker = (
    await owner.post('/hr/employees', {
      fullName: 'Sana Statutory',
      mobile: '9400000001',
      branchId: t.branch.id,
      joiningDate: '2019-06-01',
    })
  ).body;
  basic = (
    await payroll.post('/payroll/components', { name: 'Basic', code: 'BASIC', kind: 'earning' })
  ).body;
  await payroll.post('/payroll/structures', {
    employeeId: worker.id,
    effectiveFrom: '2026-01-01',
    lines: [{ componentId: basic.id, amount: '15000' }],
  });
  // A fully present October so that no loss of pay applies.
  const rows = [];
  for (let d = 1; d <= 31; d++) {
    const date = `2026-10-${String(d).padStart(2, '0')}`;
    rows.push({
      organization_id: t.organization.id,
      employee_id: worker.id,
      branch_id: t.branch.id,
      work_date: date,
      first_in: `${date}T03:30:00Z`,
      last_out: `${date}T13:00:00Z`,
      worked_minutes: 570,
      status: 'present',
    });
  }
  await sys(db, (x) => x('attendance_days').insert(rows));
  await sys(db, (x) => x('employees').where({ id: worker.id }).update({ weekly_off_days: [] }));
});
afterAll(() => db.destroy());

describe('statutory rules', () => {
  it('validates configuration and requires a source reference', async () => {
    const bad = await payroll.post('/payroll/statutory/rules', {
      ...EPF,
      config: { employeeRatePercent: 'twelve' },
    });
    expect(bad.status).toBe(400);
    const noSource = await payroll.post('/payroll/statutory/rules', {
      ...EPF,
      sourceReference: '',
    });
    expect(noSource.status).toBe(400);
    const stateless = await payroll.post('/payroll/statutory/rules', {
      ruleType: 'professional_tax',
      effectiveFrom: '2026-01-01',
      sourceReference: 'x fixture',
      config: { slabs: [{ fromGross: '0', toGross: null, amount: '100' }] },
    });
    expect(stateless.status).toBe(400);
  });

  it('drafts are not used until approved by someone with approval rights', async () => {
    const draft = await payroll.post('/payroll/statutory/rules', EPF);
    expect(draft.status).toBe(201);
    expect(draft.body.approvalStatus).toBe('draft');
    rules.epf = draft.body;
    expect((await payroll.post(`/payroll/statutory/rules/${rules.epf.id}/approve`)).status).toBe(
      403,
    );
    const ok = await owner.post(`/payroll/statutory/rules/${rules.epf.id}/approve`);
    expect(ok.body).toMatchObject({ approvalStatus: 'approved', approvedBy: 'Owner stat' });
  });

  it('approved rules are immutable and overlapping versions are refused', async () => {
    await expect(
      sys(db, (x) =>
        x('statutory_rules')
          .where({ id: rules.epf.id })
          .update({ configuration_json: { tampered: true } }),
      ),
    ).rejects.toThrow(/immutable/);
    expect((await payroll.del(`/payroll/statutory/rules/${rules.epf.id}`)).status).toBe(409);
    const v2 = await payroll.post('/payroll/statutory/rules', {
      ...EPF,
      effectiveFrom: '2027-01-01',
      config: { ...EPF.config, employeeRatePercent: '9' },
    });
    const overlap = await owner.post(`/payroll/statutory/rules/${v2.body.id}/approve`);
    expect(overlap.body.error.code).toBe('RULE_OVERLAP');
    expect((await payroll.del(`/payroll/statutory/rules/${v2.body.id}`)).status).toBe(204);
  });

  it('adds ESI, state professional tax and gratuity tracking rules', async () => {
    for (const body of [
      {
        ruleType: 'esi',
        effectiveFrom: '2026-01-01',
        sourceReference: 'Fixture',
        config: {
          employeeRatePercent: '1',
          employerRatePercent: '3',
          eligibilityGrossCeiling: '20000',
          rounding: 'up_rupee',
        },
      },
      {
        ruleType: 'professional_tax',
        jurisdiction: 'XX',
        effectiveFrom: '2026-01-01',
        sourceReference: 'Fixture',
        config: {
          slabs: [
            { fromGross: '0', toGross: '9999.99', amount: '0' },
            { fromGross: '10000', toGross: null, amount: '150' },
          ],
        },
      },
      {
        ruleType: 'gratuity',
        effectiveFrom: '2026-01-01',
        sourceReference: 'Fixture',
        config: {
          daysPerYear: 15,
          divisorDays: 26,
          minServiceYears: 5,
          wageComponentCodes: ['BASIC'],
        },
      },
    ]) {
      const r = await payroll.post('/payroll/statutory/rules', body);
      expect(r.status).toBe(201);
      expect((await owner.post(`/payroll/statutory/rules/${r.body.id}/approve`)).status).toBe(200);
    }
  });
});

describe('statutory deductions in payroll', () => {
  let runId;
  let item;

  it('enrols the employee and applies PF, ESI, PT and TDS', async () => {
    const enrol = await payroll.put(`/payroll/statutory/employees/${worker.id}`, {
      pfApplicable: true,
      esiApplicable: true,
      lwfApplicable: false,
      ptState: 'xx',
      tdsMonthlyAmount: '500',
    });
    expect(enrol.status).toBe(200);
    runId = (await payroll.post('/payroll/runs', { month: '2026-10' })).body.id;
    await payroll.post(`/payroll/runs/${runId}/calculate`);
    item = (await payroll.get(`/payroll/runs/${runId}`)).body.items[0];
    const line = (code) => item.lines.find((l) => l.code === code);
    expect(line('PF_EE')).toMatchObject({ kind: 'deduction', amount: '1500.00' });
    expect(line('PF_ER')).toMatchObject({ kind: 'employer', amount: '1650.00' });
    expect(line('ESI_EE').amount).toBe('150.00');
    expect(line('PT')).toMatchObject({ label: 'Professional tax (XX)', amount: '150.00' });
    expect(line('TDS').amount).toBe('500.00');
    // Employer shares are shown but not deducted.
    expect(item.grossEarnings).toBe('15000.00');
    expect(item.totalDeductions).toBe('2300.00');
    expect(item.netPay).toBe('12700.00');
  });

  it('records the rule versions used and stays reproducible', async () => {
    const snap = await sys(db, (x) =>
      x('payroll_items').where({ id: item.id }).first('calculation_snapshot'),
    );
    expect(snap.calculation_snapshot.statutoryRules.map((r) => r.type).sort()).toEqual([
      'epf',
      'esi',
      'professional_tax',
    ]);
    expect(
      (await payroll.get(`/payroll/runs/${runId}/items/${item.id}/verify`)).body.reproducible,
    ).toBe(true);
  });

  it('an approved rule used by approved payroll cannot be ended before that payroll', async () => {
    await owner.post(`/payroll/runs/${runId}/approve`, { confirm: true });
    const early = await owner.post(`/payroll/statutory/rules/${rules.epf.id}/end`, {
      effectiveTo: '2026-09-30',
    });
    expect(early.body.error.code).toBe('RULE_IN_USE');
    const ok = await owner.post(`/payroll/statutory/rules/${rules.epf.id}/end`, {
      effectiveTo: '2026-12-31',
    });
    expect(ok.body.effectiveTo).toBe('2026-12-31');
  });

  it('statutory register CSV and gratuity estimate', async () => {
    const csv = await payroll.get(`/payroll/statutory/runs/${runId}.csv`);
    expect(csv.text).toContain('PF_EE');
    expect(csv.text).toContain('1500.00');
    const g = await payroll.get('/payroll/statutory/gratuity?asOf=2026-11-10');
    const row = g.body.data.find((r) => r.employee.id === worker.id);
    // 7 completed years; 15000 × 15 / 26 × 7 = 60576.92
    expect(row).toMatchObject({ completedYears: 7, eligible: true, estimatedAmount: '60576.92' });
  });

  it('is isolated per organization', async () => {
    const otherOwner = api((await login(app, other.owner.email)).token);
    expect((await otherOwner.get('/payroll/statutory/rules')).body.data).toEqual([]);
    expect((await otherOwner.post(`/payroll/statutory/rules/${rules.epf.id}/approve`)).status).toBe(
      404,
    );
    expect(
      (
        await otherOwner.put(`/payroll/statutory/employees/${worker.id}`, {
          pfApplicable: false,
          esiApplicable: false,
          lwfApplicable: false,
          ptState: null,
          tdsMonthlyAmount: null,
        })
      ).status,
    ).toBe(404);
  });
});
