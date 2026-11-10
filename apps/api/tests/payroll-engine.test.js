import { describe, expect, it } from 'vitest';
import {
  amountInWords,
  attendanceMetrics,
  computePayslip,
  fromPaise,
  mulDivRound,
  toPaise,
} from '../src/modules/hr-payroll/engine.js';

const BASIC = {
  id: 'c1',
  code: 'BASIC',
  name: 'Basic',
  kind: 'earning',
  calc: 'fixed',
  includeInDayRate: true,
  displayOrder: 1,
};
const HRA = {
  id: 'c2',
  code: 'HRA',
  name: 'HRA',
  kind: 'earning',
  calc: 'percent_of_component',
  percent: '40',
  baseComponentId: 'c1',
  includeInDayRate: true,
  displayOrder: 2,
};
const CONV = {
  id: 'c3',
  code: 'CONV',
  name: 'Conveyance',
  kind: 'earning',
  calc: 'fixed',
  includeInDayRate: false,
  displayOrder: 3,
};
const COMPONENTS = [BASIC, HRA, CONV];
const METRICS = {
  daysInPeriod: 30,
  workingDays: 26,
  lopDays: 0,
  absentDays: 0,
  halfDays: 0,
  incompleteDays: 0,
  reducedHourDays: 0,
  overtimeMinutes: 0,
  lateBeyondFree: 0,
  incompletePeriod: false,
};
const base = (over = {}) => ({
  components: COMPONENTS,
  structureAmounts: { c1: '20000', c3: '1600' },
  settings: { dayRateBasis: 'calendar_days', fixedDays: null },
  metrics: METRICS,
  latePenalty: { mode: 'none' },
  fullDayMinutes: 540,
  policies: [],
  adjustments: [],
  ...over,
});
const line = (r, code) => r.lines.find((l) => l.code === code);

describe('money helpers', () => {
  it('converts exactly between rupees and paise', () => {
    expect(toPaise('12345.6')).toBe(1234560n);
    expect(toPaise('0.07')).toBe(7n);
    expect(fromPaise(1234560n)).toBe('12345.60');
    expect(fromPaise(-5n)).toBe('-0.05');
    expect(() => toPaise('12.345')).toThrow();
    expect(() => toPaise(0.1 + 0.2)).toThrow();
  });
  it('rounds half up only once', () => {
    expect(mulDivRound([1000n], [3n])).toBe(333n);
    expect(mulDivRound([1000n, 2n], [3n])).toBe(667n);
    expect(mulDivRound([5n], [2n])).toBe(3n);
  });
});

describe('computePayslip', () => {
  it('builds structure lines including percentages', () => {
    const r = computePayslip(base());
    expect(line(r, 'BASIC').amount).toBe('20000.00');
    expect(line(r, 'HRA')).toMatchObject({ amount: '8000.00', detail: '40% of Basic' });
    expect(r.grossEarnings).toBe('29600.00');
    expect(r.netPay).toBe('29600.00');
  });

  it('LOP uses the chosen day-rate basis and excludes components outside the day rate', () => {
    const metrics = { ...METRICS, lopDays: 1.5 };
    // day-rate base = Basic + HRA = 28000 (Conveyance excluded); 30 calendar days -> 933.33/day; 1.5 days = 1400
    expect(line(computePayslip(base({ metrics })), 'LOP').amount).toBe('1400.00');
    // working days 26 -> 28000*1.5/26 = 1615.384... -> 1615.38
    const w = computePayslip(base({ metrics, settings: { dayRateBasis: 'working_days' } }));
    expect(line(w, 'LOP').amount).toBe('1615.38');
    // fixed 26 days
    const f = computePayslip(
      base({ metrics, settings: { dayRateBasis: 'fixed_days', fixedDays: 26 } }),
    );
    expect(line(f, 'LOP').amount).toBe('1615.38');
    expect(f.dayRate).toBe('1076.92');
  });

  it('caps LOP at the day-rate base', () => {
    const r = computePayslip(base({ metrics: { ...METRICS, lopDays: 31 } }));
    expect(line(r, 'LOP').amount).toBe('28000.00');
    expect(r.netPay).toBe('1600.00');
  });

  it('applies the late penalty from the attendance policy', () => {
    const fixed = computePayslip(
      base({
        latePenalty: { mode: 'fixed_amount', amount: '150.00', penalizedLates: 3, freeAllowed: 2 },
      }),
    );
    expect(line(fixed, 'LATE').amount).toBe('150.00');
    const days = computePayslip(
      base({
        latePenalty: {
          mode: 'half_day_per_n',
          deductionDays: 0.5,
          penalizedLates: 3,
          freeAllowed: 2,
        },
      }),
    );
    expect(line(days, 'LATE').amount).toBe('466.67'); // 28000 * 0.5 / 30
  });

  it('applies company policies: fixed, percentage, per-unit with installments', () => {
    const policies = [
      {
        id: 'p1',
        code: 'CANTEEN',
        name: 'Canteen',
        kind: 'deduction',
        calc: 'fixed',
        amount: '500',
        frequency: 'monthly',
      },
      {
        id: 'p2',
        code: 'WELFARE',
        name: 'Welfare fund',
        kind: 'deduction',
        calc: 'percent_of_component',
        percent: '1.5',
        baseComponentId: 'c1',
        frequency: 'monthly',
      },
      {
        id: 'p3',
        code: 'OT',
        name: 'Overtime',
        kind: 'earning',
        calc: 'per_unit',
        unitMetric: 'overtime_hours',
        unitRate: 'hourly_rate',
        multiplier: '1.5',
        frequency: 'monthly',
      },
      {
        id: 'p4',
        code: 'ADV',
        name: 'Salary advance',
        kind: 'deduction',
        calc: 'fixed',
        amount: '2000',
        frequency: 'installments',
        installments: 5,
        installmentsUsed: 2,
      },
    ];
    const r = computePayslip(base({ policies, metrics: { ...METRICS, overtimeMinutes: 150 } }));
    expect(line(r, 'CANTEEN').amount).toBe('500.00');
    expect(line(r, 'WELFARE').amount).toBe('300.00');
    // hourly = 28000 / 30 / 9h = 103.7037; × 2.5h × 1.5 = 388.888.. -> 388.89
    expect(line(r, 'OT').amount).toBe('388.89');
    expect(line(r, 'ADV').label).toBe('Salary advance (3 of 5)');
    expect(r.grossEarnings).toBe('29988.89');
    expect(r.totalDeductions).toBe('2800.00');
    expect(r.netPay).toBe('27188.89');
  });

  it('includes adjustments and statutory lines and flags negative net pay', () => {
    const r = computePayslip(
      base({
        adjustments: [
          { kind: 'deduction', label: 'Recovery', amount: '40000', reason: 'Overpaid in March' },
        ],
        statutoryLines: [
          {
            kind: 'deduction',
            code: 'PT',
            label: 'Professional tax',
            amount: '200.00',
            detail: 'rule v1',
          },
        ],
      }),
    );
    expect(line(r, 'PT').source).toBe('statutory');
    expect(r.netPay).toBe('-10600.00');
    expect(r.warnings.map((w) => w.code)).toContain('NET_NEGATIVE');
  });

  it('is deterministic: the same input gives the same output', () => {
    const input = base({ metrics: { ...METRICS, lopDays: 2.5 } });
    expect(computePayslip(input)).toEqual(computePayslip(structuredClone(input)));
  });
});

describe('attendanceMetrics', () => {
  const day = (status, extra = {}) => ({
    status,
    isHoliday: false,
    isWeekOff: false,
    leave: null,
    ...extra,
  });
  const month = (days) => ({
    days,
    summary: { overtimeMinutes: 90 },
    latePenalty: { lateCount: 4, penalizedLates: 2 },
  });
  const settings = { incompleteDayLop: '1', reducedHoursLop: '0.5' };

  it('counts loss of pay from statuses and leave', () => {
    const m = attendanceMetrics(
      month([
        day('present'),
        day('absent'),
        day('half_day'),
        day('half_day', { leave: { isPaid: true, fraction: 0.5 } }),
        day('leave', { leave: { isPaid: true, fraction: 1 } }),
        day('leave', { leave: { isPaid: true, fraction: 0.5 } }),
        day('leave', { leave: { isPaid: false, fraction: 1 } }),
        day('incomplete'),
        day('reduced_hours'),
        day('week_off', { isWeekOff: true }),
        day('holiday', { isHoliday: true }),
        day('not_employed'),
      ]),
      settings,
    );
    // absent 1 + half 0.5 + covered half 0 + paid leave 0 + half paid leave 0.5 + unpaid 1 + incomplete 1 + reduced 0.5 + not employed 1
    expect(m.lopDays).toBe(5.5);
    expect(m).toMatchObject({
      workingDays: 10,
      paidLeaveDays: 2,
      unpaidLeaveDays: 1,
      lateBeyondFree: 2,
      overtimeMinutes: 90,
    });
  });

  it('marks a period that has not ended', () => {
    expect(
      attendanceMetrics(month([day('present'), day('upcoming')]), settings).incompletePeriod,
    ).toBe(true);
  });
});

describe('amountInWords', () => {
  it('uses the Indian numbering system', () => {
    expect(amountInWords('125430.50')).toBe(
      'Rupees One Lakh Twenty Five Thousand Four Hundred Thirty and Fifty Paise Only',
    );
    expect(amountInWords('10000000')).toBe('Rupees One Crore Only');
    expect(amountInWords('0')).toBe('Rupees Zero Only');
  });
});
