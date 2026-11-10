import { describe, expect, it } from 'vitest';
import {
  RULE_CONFIG_SCHEMAS,
  computeStatutory,
  earned,
  gratuityEstimate,
  ruleInForce,
} from '../src/modules/hr-statutory/calc.js';

// Test values below are arbitrary fixtures for checking arithmetic, NOT statutory rates.
const BASIC = {
  id: 'c1',
  code: 'BASIC',
  name: 'Basic',
  kind: 'earning',
  calc: 'fixed',
  includeInDayRate: true,
  displayOrder: 1,
};
const DA = {
  id: 'c2',
  code: 'DA',
  name: 'DA',
  kind: 'earning',
  calc: 'fixed',
  includeInDayRate: true,
  displayOrder: 2,
};
const HRA = {
  id: 'c3',
  code: 'HRA',
  name: 'HRA',
  kind: 'earning',
  calc: 'percent_of_component',
  percent: '50',
  baseComponentId: 'c1',
  includeInDayRate: true,
  displayOrder: 3,
};
const components = [BASIC, DA, HRA];
const structureAmounts = { c1: '10000', c2: '2000' }; // gross = 10000 + 2000 + 5000 = 17000
const settings = { dayRateBasis: 'calendar_days' };
const metrics = { daysInPeriod: 30, workingDays: 26, lopDays: 0 };
const rule = (ruleType, config, extra = {}) => ({
  id: `r-${ruleType}`,
  ruleType,
  jurisdiction: 'IN',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  approvalStatus: 'approved',
  sourceReference: 'Fixture',
  config,
  ...extra,
});
const EPF = rule('epf', {
  employeeRatePercent: '10',
  employerRatePercent: '11',
  wageComponentCodes: ['BASIC', 'DA'],
  wageCeiling: '11000',
  rounding: 'nearest_rupee',
});
const ESI = rule('esi', {
  employeeRatePercent: '1',
  employerRatePercent: '3',
  eligibilityGrossCeiling: '20000',
  rounding: 'up_rupee',
});
const PT = rule(
  'professional_tax',
  {
    slabs: [
      { fromGross: '0', toGross: '9999.99', amount: '0' },
      { fromGross: '10000', toGross: null, amount: '150' },
    ],
    monthOverrides: [{ month: 2, amount: '250' }],
  },
  { jurisdiction: 'XX' },
);
const LWF = rule(
  'lwf',
  { employeeAmount: '5', employerAmount: '10', months: [6, 12] },
  { jurisdiction: 'XX' },
);
const ALL = {
  pfApplicable: true,
  esiApplicable: true,
  lwfApplicable: true,
  ptState: 'XX',
  tdsMonthlyAmount: '750.00',
};
const run = (over = {}) =>
  computeStatutory({
    rules: [EPF, ESI, PT, LWF],
    statutory: ALL,
    components,
    structureAmounts,
    metrics,
    settings,
    periodEnd: '2026-10-31',
    ...over,
  });
const line = (r, code) => r.lines.find((l) => l.code === code);

describe('rule configuration schemas', () => {
  it('validate each rule type', () => {
    expect(RULE_CONFIG_SCHEMAS.epf.safeParse(EPF.config).success).toBe(true);
    expect(
      RULE_CONFIG_SCHEMAS.epf.safeParse({ ...EPF.config, wageComponentCodes: [] }).success,
    ).toBe(false);
    expect(RULE_CONFIG_SCHEMAS.professional_tax.safeParse(PT.config).success).toBe(true);
    expect(RULE_CONFIG_SCHEMAS.esi.safeParse({ employeeRatePercent: 'abc' }).success).toBe(false);
  });
});

describe('ruleInForce', () => {
  it('uses only approved rules in their dates, latest first', () => {
    const v2 = { ...EPF, id: 'v2', effectiveFrom: '2026-07-01' };
    const draft = { ...EPF, id: 'draft', effectiveFrom: '2026-09-01', approvalStatus: 'draft' };
    expect(ruleInForce([EPF, v2, draft], 'epf', 'IN', '2026-10-31').id).toBe('v2');
    expect(ruleInForce([EPF, v2], 'epf', 'IN', '2026-03-31').id).toBe('r-epf');
    expect(
      ruleInForce([{ ...EPF, effectiveTo: '2026-06-30' }], 'epf', 'IN', '2026-10-31'),
    ).toBeUndefined();
  });
});

describe('computeStatutory', () => {
  it('PF on chosen components with a wage ceiling, employee and employer shares', () => {
    const r = run();
    // PF wages = Basic 10000 + DA 2000 = 12000, capped at 11000
    expect(line(r, 'PF_EE')).toMatchObject({ kind: 'deduction', amount: '1100.00' });
    expect(line(r, 'PF_ER')).toMatchObject({ kind: 'employer', amount: '1210.00' });
  });

  it('ESI on gross when under the eligibility ceiling, with configured rounding', () => {
    const r = run();
    expect(line(r, 'ESI_EE').amount).toBe('170.00');
    expect(line(r, 'ESI_ER').amount).toBe('510.00');
    const over = computeStatutory({
      rules: [ESI],
      statutory: ALL,
      components,
      structureAmounts: { c1: '20000' },
      metrics,
      settings,
      periodEnd: '2026-10-31',
    });
    expect(line(over, 'ESI_EE')).toBeUndefined();
  });

  it('professional tax by slab, with month overrides; LWF only in its months', () => {
    expect(line(run(), 'PT').amount).toBe('150.00');
    expect(line(run({ periodEnd: '2026-02-28' }), 'PT').amount).toBe('250.00');
    expect(line(run(), 'LWF_EE')).toBeUndefined();
    expect(line(run({ periodEnd: '2026-12-31' }), 'LWF_EE').amount).toBe('5.00');
  });

  it('works on earned wages after loss of pay', () => {
    const r = run({ metrics: { ...metrics, lopDays: 15 } });
    // half the month earned: PF wages 6000 (under ceiling) -> 600; gross 8500 -> PT slab 0
    expect(line(r, 'PF_EE').amount).toBe('600.00');
    expect(line(r, 'PT')).toBeUndefined();
    expect(earned(1000000n, 30, 1.5)).toBe(950000n);
  });

  it('TDS is the monthly amount set by payroll', () => {
    expect(line(run(), 'TDS').amount).toBe('750.00');
  });

  it('applies nothing for employees not enrolled, and records the rule versions used', () => {
    const none = run({
      statutory: {
        pfApplicable: false,
        esiApplicable: false,
        lwfApplicable: false,
        ptState: null,
        tdsMonthlyAmount: null,
      },
    });
    expect(none.lines).toEqual([]);
    expect(run().rules.map((x) => x.type)).toEqual(['epf', 'esi', 'professional_tax']);
  });
});

describe('gratuityEstimate', () => {
  it('estimates from completed years and configured days', () => {
    const g = gratuityEstimate({
      rule: rule('gratuity', {
        daysPerYear: 15,
        divisorDays: 26,
        minServiceYears: 5,
        wageComponentCodes: ['BASIC', 'DA'],
      }),
      components,
      structureAmounts,
      joiningDate: '2019-11-15',
      asOf: '2026-11-10',
    });
    // 6 completed years; 12000 × 15 / 26 × 6 = 41538.46
    expect(g).toMatchObject({ completedYears: 6, eligible: true, estimatedAmount: '41538.46' });
  });
});
