/**
 * Pure leave calculations (no I/O), unit-tested in tests/leave-calc.test.js.
 * Day counts are multiples of 0.5, which are exact in floating point.
 */
import { addDays, dayOfWeek, monthEnd } from '../hr-attendance/calc.js';

const pad = (n) => String(n).padStart(2, '0');

/** The leave year a date falls in, labelled by the calendar year in which that leave year starts. */
export function leaveYearOf(date, startMonth) {
  const [y, m] = date.split('-').map(Number);
  return m >= startMonth ? y : y - 1;
}

export function leaveYearRange(year, startMonth) {
  const start = `${year}-${pad(startMonth)}-01`;
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const endYear = startMonth === 1 ? year : year + 1;
  return { start, end: monthEnd(`${endYear}-${pad(endMonth)}`) };
}

/**
 * Working days a leave consumes: week offs and holidays are skipped; a half day on the first/last day
 * counts 0.5. Returns { days, dates: [{ date, fraction }] }.
 */
export function countLeaveDays({ start, end, startHalf, endHalf, weeklyOffDays, holidays }) {
  const dates = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (weeklyOffDays.includes(dayOfWeek(d)) || holidays.has(d)) continue;
    let fraction = 1;
    if (d === start && startHalf) fraction = 0.5;
    if (d === end && endHalf) fraction = start === end ? 0.5 : Math.min(fraction, 0.5);
    dates.push({ date: d, fraction });
  }
  return { days: dates.reduce((a, x) => a + x.fraction, 0), dates };
}

const floorHalf = (n) => Math.floor(n * 2) / 2;
const monthIndex = (date) => {
  const [y, m] = date.split('-').map(Number);
  return y * 12 + (m - 1);
};

/**
 * Days accrued for a leave type in a leave year, as of a date.
 * - yearly_upfront: the full quota at the start of the year (prorated by months if joined mid-year).
 * - monthly: quota / 12 for each month started, from the later of year start and joining month.
 * - none: 0 (for example unpaid leave).
 * Rounded down to the nearest half day.
 */
export function accruedDays({ type, year, startMonth, joiningDate, asOf }) {
  const quota = Number(type.annual_quota ?? type.annualQuota ?? 0);
  if (type.accrual === 'none' || quota === 0) return 0;
  const range = leaveYearRange(year, startMonth);
  if (joiningDate > range.end) return 0;
  const firstMonth = Math.max(monthIndex(range.start), monthIndex(joiningDate));
  const lastMonth = monthIndex(range.end);
  if (type.accrual === 'yearly_upfront') {
    return floorHalf((quota * (lastMonth - firstMonth + 1)) / 12);
  }
  const upTo = Math.min(lastMonth, monthIndex(asOf));
  if (upTo < firstMonth) return 0;
  return floorHalf((quota * (upTo - firstMonth + 1)) / 12);
}
