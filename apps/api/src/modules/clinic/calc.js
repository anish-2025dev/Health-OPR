import { hhmmToMinutes, localParts, zonedToUtc } from '../hr-attendance/calc.js';

/**
 * Pure scheduling and queue helpers (no database), so they can be unit tested.
 */

export const ACTIVE_QUEUE_STATUSES = ['booked', 'waiting', 'called', 'in_consultation'];
const SERVING = ['called', 'in_consultation'];

/**
 * Bookable slots for one doctor on one local date.
 * @param schedules   [{ start_time, end_time, slot_minutes, patients_per_slot }] for that weekday
 * @param bookedCounts Map<slotStartIso, number> of active appointments per slot
 * @param now         Date; slots starting before now are not bookable
 */
export function buildSlots({
  date,
  timeZone,
  schedules,
  bookedCounts = new Map(),
  now = new Date(),
}) {
  const slots = [];
  for (const s of [...schedules].sort(
    (a, b) => hhmmToMinutes(a.start_time) - hhmmToMinutes(b.start_time),
  )) {
    const from = hhmmToMinutes(s.start_time);
    const to = hhmmToMinutes(s.end_time);
    for (let m = from; m + s.slot_minutes <= to; m += s.slot_minutes) {
      const hhmm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      const start = zonedToUtc(date, hhmm, timeZone);
      const end = new Date(start.getTime() + s.slot_minutes * 60_000);
      const booked = bookedCounts.get(start.toISOString()) ?? 0;
      slots.push({
        start: start.toISOString(),
        end: end.toISOString(),
        time: hhmm,
        capacity: s.patients_per_slot,
        booked,
        available: start > now && booked < s.patients_per_slot,
      });
    }
  }
  return slots;
}

/** Today's local date in a timezone. */
export const localDate = (timeZone, now = new Date()) => localParts(now, timeZone).date;

/** Queue order: patients being served first, then by priority (higher first), then token number. */
export function queueOrder(a, b) {
  const sa = SERVING.includes(a.status) ? 0 : 1;
  const sb = SERVING.includes(b.status) ? 0 : 1;
  if (sa !== sb) return sa - sb;
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.token_number - b.token_number;
}

/**
 * Average consultation length from today's completed consultations, falling back to the doctor's
 * configured minutes until there are at least three.
 */
export function averageConsultationMinutes(entries, fallbackMinutes) {
  const durations = entries
    .filter((e) => e.status === 'completed' && e.started_at && e.completed_at)
    .map((e) => (new Date(e.completed_at) - new Date(e.started_at)) / 60_000)
    .filter((m) => m > 0 && m < 240);
  if (durations.length < 3) return fallbackMinutes;
  return Math.max(1, Math.round(durations.reduce((s, m) => s + m, 0) / durations.length));
}

/**
 * Approximate queue position for one entry (spec: estimates are labelled approximate and never promise
 * an exact consultation time).
 */
export function queuePosition(entries, entryId, fallbackMinutes) {
  const active = entries.filter((e) => ACTIVE_QUEUE_STATUSES.includes(e.status)).sort(queueOrder);
  const me = entries.find((e) => e.id === entryId);
  const nowServing = entries
    .filter((e) => SERVING.includes(e.status))
    .sort((a, b) => new Date(b.called_at ?? 0) - new Date(a.called_at ?? 0))[0];
  const avg = averageConsultationMinutes(entries, fallbackMinutes);
  if (!me || !ACTIVE_QUEUE_STATUSES.includes(me.status)) {
    return {
      status: me?.status ?? null,
      ahead: 0,
      nowServingToken: nowServing?.token_number ?? null,
      estimatedWaitMinutes: 0,
      averageConsultationMinutes: avg,
    };
  }
  const index = active.findIndex((e) => e.id === entryId);
  const ahead = SERVING.includes(me.status) ? 0 : index;
  return {
    status: me.status,
    ahead,
    nowServingToken: nowServing?.token_number ?? null,
    estimatedWaitMinutes: ahead * avg,
    averageConsultationMinutes: avg,
  };
}

/** Allowed queue status transitions. */
export const TRANSITIONS = {
  check_in: { from: ['booked'], to: 'waiting' },
  call: { from: ['waiting', 'called'], to: 'called' },
  start: { from: ['waiting', 'called'], to: 'in_consultation' },
  complete: { from: ['called', 'in_consultation'], to: 'completed' },
  no_show: { from: ['booked', 'waiting', 'called'], to: 'no_show' },
  cancel: { from: ['booked', 'waiting', 'called'], to: 'cancelled' },
  requeue: { from: ['called', 'no_show'], to: 'waiting' },
};
