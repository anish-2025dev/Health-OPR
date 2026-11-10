import { describe, expect, it } from 'vitest';
import {
  accruedDays,
  countLeaveDays,
  leaveYearOf,
  leaveYearRange,
} from '../src/modules/hr-leave/calc.js';

describe('leave year', () => {
  it('calendar year', () => {
    expect(leaveYearOf('2026-03-10', 1)).toBe(2026);
    expect(leaveYearRange(2026, 1)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });
  it('April–March year', () => {
    expect(leaveYearOf('2026-03-10', 4)).toBe(2025);
    expect(leaveYearOf('2026-04-01', 4)).toBe(2026);
    expect(leaveYearRange(2026, 4)).toEqual({ start: '2026-04-01', end: '2027-03-31' });
  });
});

describe('countLeaveDays', () => {
  const base = { weeklyOffDays: [0], holidays: new Set(['2026-11-14']) };
  it('skips week offs and holidays', () => {
    // Thu 12 – Mon 16 Nov 2026: Sat 14 holiday, Sun 15 week off -> 12, 13, 16
    const r = countLeaveDays({
      ...base,
      start: '2026-11-12',
      end: '2026-11-16',
      startHalf: false,
      endHalf: false,
    });
    expect(r.days).toBe(3);
    expect(r.dates.map((d) => d.date)).toEqual(['2026-11-12', '2026-11-13', '2026-11-16']);
  });
  it('half days', () => {
    expect(
      countLeaveDays({
        ...base,
        start: '2026-11-12',
        end: '2026-11-12',
        startHalf: true,
        endHalf: false,
      }).days,
    ).toBe(0.5);
    expect(
      countLeaveDays({
        ...base,
        start: '2026-11-12',
        end: '2026-11-13',
        startHalf: true,
        endHalf: true,
      }).days,
    ).toBe(1);
  });
  it('a leave entirely on off days counts zero', () => {
    expect(
      countLeaveDays({
        ...base,
        start: '2026-11-14',
        end: '2026-11-15',
        startHalf: false,
        endHalf: false,
      }).days,
    ).toBe(0);
  });
});

describe('accruedDays', () => {
  const upfront = { annual_quota: '12', accrual: 'yearly_upfront' };
  const monthly = { annual_quota: '12', accrual: 'monthly' };
  it('upfront: full quota, prorated for mid-year joiners', () => {
    expect(
      accruedDays({
        type: upfront,
        year: 2026,
        startMonth: 1,
        joiningDate: '2020-01-01',
        asOf: '2026-02-01',
      }),
    ).toBe(12);
    // joined in July: 6 of 12 months
    expect(
      accruedDays({
        type: upfront,
        year: 2026,
        startMonth: 1,
        joiningDate: '2026-07-15',
        asOf: '2026-08-01',
      }),
    ).toBe(6);
  });
  it('monthly: earned month by month', () => {
    expect(
      accruedDays({
        type: monthly,
        year: 2026,
        startMonth: 1,
        joiningDate: '2020-01-01',
        asOf: '2026-03-10',
      }),
    ).toBe(3);
    expect(
      accruedDays({
        type: { annual_quota: '7', accrual: 'monthly' },
        year: 2026,
        startMonth: 1,
        joiningDate: '2020-01-01',
        asOf: '2026-05-01',
      }),
    ).toBe(2.5);
    // April–March year, joined in June, as of August: Jun, Jul, Aug
    expect(
      accruedDays({
        type: monthly,
        year: 2026,
        startMonth: 4,
        joiningDate: '2026-06-20',
        asOf: '2026-08-05',
      }),
    ).toBe(3);
  });
  it('none / zero quota', () => {
    expect(
      accruedDays({
        type: { annual_quota: '0', accrual: 'none' },
        year: 2026,
        startMonth: 1,
        joiningDate: '2020-01-01',
        asOf: '2026-05-01',
      }),
    ).toBe(0);
  });
});
