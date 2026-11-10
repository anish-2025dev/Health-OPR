import { describe, expect, it } from 'vitest';
import {
  checkGeofence,
  computeDay,
  distanceMeters,
  latePenalty,
  localParts,
  workDateFor,
  zonedToUtc,
} from '../src/modules/hr-attendance/calc.js';

const TZ = 'Asia/Kolkata';
const POLICY = {
  fullDayMinutes: 540,
  halfDayMinutes: 300,
  belowHalfDayStatus: 'absent',
  lateGraceMinutes: 15,
  overtimeAfterMinutes: 30,
};
const SHIFT = { start: '09:00', end: '18:00', breakMinutes: 60 };
const at = (date, hhmm) => zonedToUtc(date, hhmm, TZ);
const day = (overrides) =>
  computeDay({
    policy: POLICY,
    shift: SHIFT,
    workDate: '2026-03-02',
    timeZone: TZ,
    isHoliday: false,
    isWeekOff: false,
    today: '2026-03-10',
    firstIn: null,
    lastOut: null,
    ...overrides,
  });

describe('geofence', () => {
  const branch = { location: { latitude: 12.9716, longitude: 77.5946 }, geofenceRadiusM: 10 };

  it('measures distance in metres', () => {
    // 0.0001 degrees of latitude ≈ 11.1 m
    const d = distanceMeters(branch.location, { latitude: 12.9717, longitude: 77.5946 });
    expect(d).toBeGreaterThan(10.5);
    expect(d).toBeLessThan(11.5);
  });

  it('passes inside the radius with good accuracy', () => {
    const r = checkGeofence({
      branch,
      position: { latitude: 12.97163, longitude: 77.5946, accuracy: 5 },
    });
    expect(r).toMatchObject({ ok: true, radiusM: 10 });
    expect(r.distanceM).toBeLessThanOrEqual(10);
  });

  it('fails outside the radius', () => {
    const r = checkGeofence({
      branch,
      position: { latitude: 12.9718, longitude: 77.5946, accuracy: 5 },
    });
    expect(r).toMatchObject({ ok: false, reason: 'OUTSIDE_GEOFENCE' });
  });

  it('fails when accuracy is worse than the radius, even at the exact spot', () => {
    const r = checkGeofence({ branch, position: { ...branch.location, accuracy: 25 } });
    expect(r).toMatchObject({ ok: false, reason: 'LOCATION_TOO_IMPRECISE', accuracyM: 25 });
  });

  it('fails when the branch has no location set', () => {
    const r = checkGeofence({
      branch: { location: null, geofenceRadiusM: 10 },
      position: branch.location,
    });
    expect(r.reason).toBe('BRANCH_LOCATION_NOT_SET');
  });
});

describe('time zones', () => {
  it('converts IST local time to UTC and back', () => {
    const utc = zonedToUtc('2026-03-02', '09:00', TZ);
    expect(utc.toISOString()).toBe('2026-03-02T03:30:00.000Z');
    expect(localParts(utc, TZ)).toMatchObject({ date: '2026-03-02', minutes: 540, dayOfWeek: 1 });
  });

  it('puts an early-morning check-out of a night shift on the previous work date', () => {
    const night = { start: '21:00', end: '07:00' };
    expect(workDateFor(at('2026-03-03', '06:30'), TZ, night)).toBe('2026-03-02');
    expect(workDateFor(at('2026-03-02', '21:05'), TZ, night)).toBe('2026-03-02');
    expect(workDateFor(at('2026-03-03', '06:30'), TZ, SHIFT)).toBe('2026-03-03');
  });
});

describe('computeDay', () => {
  it('no punches: absent, week off or holiday', () => {
    expect(day({}).status).toBe('absent');
    expect(day({ isWeekOff: true }).status).toBe('week_off');
    expect(day({ isHoliday: true }).status).toBe('holiday');
  });

  it('full day on time', () => {
    const r = day({ firstIn: at('2026-03-02', '09:05'), lastOut: at('2026-03-02', '18:10') });
    expect(r).toMatchObject({
      status: 'present',
      isLate: false,
      lateMinutes: 5,
      workedMinutes: 545,
    });
  });

  it('within grace is not late; beyond grace is late', () => {
    expect(
      day({ firstIn: at('2026-03-02', '09:15'), lastOut: at('2026-03-02', '19:00') }).isLate,
    ).toBe(false);
    const late = day({ firstIn: at('2026-03-02', '09:16'), lastOut: at('2026-03-02', '19:00') });
    expect(late).toMatchObject({ isLate: true, lateMinutes: 16 });
  });

  it('half day and below half day', () => {
    // 5h30 worked = half day; 3h = below half day
    expect(
      day({ firstIn: at('2026-03-02', '09:00'), lastOut: at('2026-03-02', '14:30') }).status,
    ).toBe('half_day');
    expect(
      day({ firstIn: at('2026-03-02', '09:00'), lastOut: at('2026-03-02', '12:00') }).status,
    ).toBe('absent');
    const reduced = computeDay({
      policy: { ...POLICY, belowHalfDayStatus: 'reduced_hours' },
      shift: SHIFT,
      workDate: '2026-03-02',
      timeZone: TZ,
      isHoliday: false,
      isWeekOff: false,
      today: '2026-03-10',
      firstIn: at('2026-03-02', '09:00'),
      lastOut: at('2026-03-02', '12:00'),
    });
    expect(reduced.status).toBe('reduced_hours');
  });

  it('overtime counts only beyond full day + threshold', () => {
    // 9h worked: no OT
    expect(
      day({ firstIn: at('2026-03-02', '09:00'), lastOut: at('2026-03-02', '18:00') })
        .overtimeMinutes,
    ).toBe(0);
    // 9h20 worked: under the 30-minute threshold
    expect(
      day({ firstIn: at('2026-03-02', '09:00'), lastOut: at('2026-03-02', '18:20') })
        .overtimeMinutes,
    ).toBe(0);
    // 10h worked: 60 min OT
    expect(
      day({ firstIn: at('2026-03-02', '09:00'), lastOut: at('2026-03-02', '19:00') })
        .overtimeMinutes,
    ).toBe(60);
  });

  it('checked in today vs. missed check-out on a past day', () => {
    expect(day({ firstIn: at('2026-03-02', '09:00'), today: '2026-03-02' }).status).toBe(
      'checked_in',
    );
    expect(day({ firstIn: at('2026-03-02', '09:00') }).status).toBe('incomplete');
  });

  it('is never late on a week off or holiday', () => {
    const r = day({
      isWeekOff: true,
      firstIn: at('2026-03-02', '11:00'),
      lastOut: at('2026-03-02', '20:00'),
    });
    expect(r.isLate).toBe(false);
    expect(r.isWeekOff).toBe(true);
  });

  it('handles overnight shifts', () => {
    const r = computeDay({
      policy: POLICY,
      shift: { start: '21:00', end: '07:00', breakMinutes: 60 },
      workDate: '2026-03-02',
      timeZone: TZ,
      isHoliday: false,
      isWeekOff: false,
      today: '2026-03-10',
      firstIn: at('2026-03-02', '21:30'),
      lastOut: at('2026-03-03', '07:30'),
    });
    expect(r).toMatchObject({
      status: 'present',
      lateMinutes: 30,
      isLate: true,
      workedMinutes: 600,
    });
  });
});

describe('latePenalty', () => {
  const base = { lateFreePerMonth: 3 };
  it('none: only counts', () => {
    expect(latePenalty({ ...base, latePenaltyMode: 'none' }, 5)).toMatchObject({
      penalizedLates: 2,
    });
  });
  it('fixed amount per late beyond the free count, in exact decimals', () => {
    const r = latePenalty(
      { ...base, latePenaltyMode: 'fixed_amount', latePenaltyAmount: '50.10' },
      6,
    );
    expect(r).toMatchObject({ penalizedLates: 3, amount: '150.30' });
    expect(
      latePenalty({ ...base, latePenaltyMode: 'fixed_amount', latePenaltyAmount: '50' }, 2).amount,
    ).toBe('0.00');
  });
  it('every N lates = half day / full day', () => {
    expect(
      latePenalty({ ...base, latePenaltyMode: 'half_day_per_n', latePenaltyEveryN: 3 }, 10)
        .deductionDays,
    ).toBe(1);
    expect(
      latePenalty({ ...base, latePenaltyMode: 'full_day_per_n', latePenaltyEveryN: 2 }, 8)
        .deductionDays,
    ).toBe(2);
  });
});
