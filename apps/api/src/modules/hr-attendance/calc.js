/**
 * Pure attendance calculations (no I/O), unit-tested in tests/attendance-calc.test.js.
 * Timestamps are stored in UTC; all "local" values use the branch's IANA timezone.
 */

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in metres between two { latitude, longitude } points. */
export function distanceMeters(a, b) {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Geofence rule (requirements §2.3): the phone must be within the branch radius AND report an
 * accuracy no worse than the radius. Returns { ok, reason?, distanceM, accuracyM, radiusM }.
 */
export function checkGeofence({ branch, position }) {
  const radiusM = branch.geofenceRadiusM;
  if (!branch.location) return { ok: false, reason: 'BRANCH_LOCATION_NOT_SET', radiusM };
  const accuracyM = Math.round(position.accuracy * 10) / 10;
  const distanceM = Math.round(distanceMeters(branch.location, position) * 10) / 10;
  if (accuracyM > radiusM)
    return { ok: false, reason: 'LOCATION_TOO_IMPRECISE', distanceM, accuracyM, radiusM };
  if (distanceM > radiusM)
    return { ok: false, reason: 'OUTSIDE_GEOFENCE', distanceM, accuracyM, radiusM };
  return { ok: true, distanceM, accuracyM, radiusM };
}

// ------------------------------------------------------------------ time zones

const partsFormatter = new Map();
function formatterFor(timeZone) {
  if (!partsFormatter.has(timeZone)) {
    partsFormatter.set(
      timeZone,
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    );
  }
  return partsFormatter.get(timeZone);
}

/** Local calendar date (YYYY-MM-DD) and minutes since local midnight for an instant. */
export function localParts(instant, timeZone) {
  const p = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(new Date(instant))
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    dayOfWeek: new Date(`${p.year}-${p.month}-${p.day}T00:00:00Z`).getUTCDay(),
  };
}

function offsetMinutes(instantMs, timeZone) {
  const p = localParts(instantMs, timeZone);
  const [y, m, d] = p.date.split('-').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, Math.floor(p.minutes / 60), p.minutes % 60);
  return Math.round((asUtc - Math.floor(instantMs / 60_000) * 60_000) / 60_000);
}

/** Converts a local date + 'HH:MM' in a timezone to a UTC Date. */
export function zonedToUtc(date, hhmm, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - offsetMinutes(guess, timeZone) * 60_000;
  return new Date(guess - offsetMinutes(first, timeZone) * 60_000);
}

export const addDays = (date, n) => {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

/** Last calendar day of a 'YYYY-MM' month, as 'YYYY-MM-DD'. */
export const monthEnd = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export const dayOfWeek = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

export const hhmmToMinutes = (t) => {
  const [h, m] = String(t).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
};

export const minutesToHhmm = (mins) => {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/**
 * Work date a check-in belongs to. For an overnight shift (e.g. 21:00-07:00), an early-morning check-in
 * before the shift end (+2 h) belongs to the previous day's shift.
 */
export function workDateFor(instant, timeZone, shift) {
  const local = localParts(instant, timeZone);
  if (shift) {
    const start = hhmmToMinutes(shift.start);
    const end = hhmmToMinutes(shift.end);
    if (end < start && local.minutes < end + 120) return addDays(local.date, -1);
  }
  return local.date;
}

// ------------------------------------------------------------------ day status

/**
 * Computes one day's attendance from first check-in / last check-out and the policy snapshot.
 *
 * @param {object} p
 * @param {object} p.policy   { fullDayMinutes, halfDayMinutes, belowHalfDayStatus, lateGraceMinutes, overtimeAfterMinutes }
 * @param {object|null} p.shift { start: 'HH:MM', end: 'HH:MM', breakMinutes }
 * @param {string} p.workDate 'YYYY-MM-DD'
 * @param {Date|null} p.firstIn
 * @param {Date|null} p.lastOut
 * @param {string} p.timeZone
 * @param {boolean} p.isHoliday
 * @param {boolean} p.isWeekOff
 * @param {string} p.today    local 'YYYY-MM-DD' in the branch timezone
 */
export function computeDay({
  policy,
  shift,
  workDate,
  firstIn,
  lastOut,
  timeZone,
  isHoliday,
  isWeekOff,
  today,
}) {
  const base = {
    workedMinutes: 0,
    lateMinutes: 0,
    isLate: false,
    overtimeMinutes: 0,
    isHoliday,
    isWeekOff,
  };
  if (!firstIn) {
    return { ...base, status: isHoliday ? 'holiday' : isWeekOff ? 'week_off' : 'absent' };
  }

  // Minutes from the work date's local midnight (can exceed 1440 for overnight shifts).
  const midnight = zonedToUtc(workDate, '00:00', timeZone).getTime();
  const inMinutes = Math.round((new Date(firstIn).getTime() - midnight) / 60_000);
  let lateMinutes = 0;
  if (shift && !isHoliday && !isWeekOff) {
    lateMinutes = Math.max(0, inMinutes - hhmmToMinutes(shift.start));
  }
  const isLate = lateMinutes > policy.lateGraceMinutes;

  if (!lastOut) {
    return {
      ...base,
      lateMinutes,
      isLate,
      status: workDate >= today ? 'checked_in' : 'incomplete',
    };
  }

  // Hours are measured from first check-in to last check-out (as in "full day 9h" for a 10:00-19:00
  // shift). The shift break is informational and is not subtracted.
  const workedMinutes = Math.max(0, Math.round((new Date(lastOut) - new Date(firstIn)) / 60_000));
  let status;
  if (workedMinutes >= policy.fullDayMinutes) status = 'present';
  else if (workedMinutes >= policy.halfDayMinutes) status = 'half_day';
  else status = policy.belowHalfDayStatus;

  const overtimeMinutes =
    workedMinutes > policy.fullDayMinutes + policy.overtimeAfterMinutes
      ? workedMinutes - policy.fullDayMinutes
      : 0;

  return { ...base, workedMinutes, lateMinutes, isLate, overtimeMinutes, status };
}

// ------------------------------------------------------------------ late penalty

const toPaise = (amount) => Math.round(Number(amount) * 100);
const fromPaise = (paise) => (paise / 100).toFixed(2);

/**
 * Monthly late penalty from the policy (requirements §2.1). Amounts are returned as decimal strings and
 * computed in integer paise, never floating-point rupees.
 */
export function latePenalty(policy, lateCount) {
  const free = policy.lateFreePerMonth;
  const penalized = Math.max(0, lateCount - free);
  const result = {
    lateCount,
    freeAllowed: free,
    penalizedLates: penalized,
    mode: policy.latePenaltyMode,
  };
  switch (policy.latePenaltyMode) {
    case 'fixed_amount':
      return { ...result, amount: fromPaise(penalized * toPaise(policy.latePenaltyAmount ?? 0)) };
    case 'half_day_per_n':
      return { ...result, deductionDays: Math.floor(penalized / policy.latePenaltyEveryN) * 0.5 };
    case 'full_day_per_n':
      return { ...result, deductionDays: Math.floor(penalized / policy.latePenaltyEveryN) };
    default:
      return result;
  }
}
