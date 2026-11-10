import { describe, expect, it } from 'vitest';
import {
  averageConsultationMinutes,
  buildSlots,
  queueOrder,
  queuePosition,
} from '../src/modules/clinic/calc.js';

const TZ = 'Asia/Kolkata';
const morning = {
  start_time: '10:00:00',
  end_time: '11:00:00',
  slot_minutes: 15,
  patients_per_slot: 2,
};

describe('buildSlots', () => {
  it('splits sessions into slots in the branch timezone', () => {
    const slots = buildSlots({
      date: '2026-12-01',
      timeZone: TZ,
      schedules: [morning],
      now: new Date('2026-11-01'),
    });
    expect(slots.map((s) => s.time)).toEqual(['10:00', '10:15', '10:30', '10:45']);
    expect(slots[0].start).toBe('2026-12-01T04:30:00.000Z');
    expect(slots.every((s) => s.available)).toBe(true);
  });

  it('marks full and past slots unavailable', () => {
    const slots = buildSlots({
      date: '2026-12-01',
      timeZone: TZ,
      schedules: [morning],
      bookedCounts: new Map([
        ['2026-12-01T04:30:00.000Z', 2],
        ['2026-12-01T04:45:00.000Z', 1],
      ]),
      now: new Date('2026-12-01T05:05:00Z'), // 10:35 local
    });
    expect(slots.map((s) => s.available)).toEqual([false, false, false, true]);
    expect(slots[1].booked).toBe(1);
  });
});

const e = (id, token, status, extra = {}) => ({
  id,
  token_number: token,
  status,
  priority: 0,
  ...extra,
});

describe('queue order and position', () => {
  it('serves the current patient first, then priority, then token', () => {
    const list = [
      e('a', 3, 'waiting'),
      e('b', 5, 'waiting', { priority: 1 }),
      e('c', 7, 'in_consultation'),
      e('d', 1, 'booked'),
    ];
    expect([...list].sort(queueOrder).map((x) => x.id)).toEqual(['c', 'b', 'd', 'a']);
  });

  it('estimates people ahead and an approximate wait', () => {
    const list = [
      e('a', 1, 'completed'),
      e('b', 2, 'in_consultation', { called_at: '2026-11-10T05:00:00Z' }),
      e('c', 3, 'waiting'),
      e('d', 4, 'booked'),
      e('me', 5, 'booked'),
      e('x', 6, 'cancelled'),
    ];
    expect(queuePosition(list, 'me', 10)).toMatchObject({
      ahead: 3,
      nowServingToken: 2,
      estimatedWaitMinutes: 30,
    });
    expect(queuePosition(list, 'a', 10)).toMatchObject({ status: 'completed', ahead: 0 });
  });

  it('learns the average consultation time after three consultations', () => {
    const done = (m) =>
      e('z', 1, 'completed', {
        started_at: '2026-11-10T05:00:00Z',
        completed_at: new Date(Date.parse('2026-11-10T05:00:00Z') + m * 60000).toISOString(),
      });
    expect(averageConsultationMinutes([done(6), done(8)], 10)).toBe(10);
    expect(averageConsultationMinutes([done(6), done(8), done(7)], 10)).toBe(7);
  });
});
