import { randomBytes } from 'node:crypto';
import { AppError, conflict, notFound } from '../../core/errors.js';
import { addDays, dayOfWeek, localParts } from '../hr-attendance/calc.js';
import { TRANSITIONS, buildSlots, localDate, queuePosition } from './calc.js';

export const newTrackingCode = () => randomBytes(12).toString('base64url');

export async function loadDoctor(trx, org, doctorId, { lock = false } = {}) {
  const q = trx('doctors as d')
    .join('branches as b', 'b.id', 'd.branch_id')
    .where({ 'd.organization_id': org, 'd.id': doctorId })
    .select('d.*', 'b.timezone', 'b.name as branch_name');
  if (lock) q.forUpdate('d');
  const doctor = await q.first();
  if (!doctor) throw notFound('Doctor not found');
  return doctor;
}

/** Slots for a doctor on a local date, with how many are booked. */
export async function slotsFor(trx, org, doctor, date, now = new Date()) {
  const off = await trx('doctor_time_off')
    .where({ organization_id: org, doctor_id: doctor.id, date })
    .first('reason');
  if (off || doctor.status !== 'active') return { date, timeOff: off?.reason ?? null, slots: [] };
  const schedules = await trx('doctor_schedules')
    .where({ organization_id: org, doctor_id: doctor.id, day_of_week: dayOfWeek(date) })
    .select('start_time', 'end_time', 'slot_minutes', 'patients_per_slot');
  const counts = await trx('appointments')
    .where({ organization_id: org, doctor_id: doctor.id, appointment_date: date })
    .whereIn('status', ['booked', 'checked_in', 'completed'])
    .groupBy('slot_start')
    .select('slot_start', trx.raw('count(*)::int AS n'));
  const bookedCounts = new Map(counts.map((c) => [new Date(c.slot_start).toISOString(), c.n]));
  return {
    date,
    timeOff: null,
    slots: buildSlots({ date, timeZone: doctor.timezone, schedules, bookedCounts, now }),
  };
}

/** Next token in the doctor's queue for the date. The row lock makes concurrent issues safe. */
async function nextToken(trx, org, doctorId, date) {
  const {
    rows: [row],
  } = await trx.raw(
    `INSERT INTO queue_counters (organization_id, doctor_id, queue_date, last_token)
     VALUES (?, ?, ?, 1)
     ON CONFLICT (organization_id, doctor_id, queue_date)
     DO UPDATE SET last_token = queue_counters.last_token + 1
     RETURNING last_token`,
    [org, doctorId, date],
  );
  return row.last_token;
}

function translateUnique(err) {
  if (err.code !== '23505') return err;
  if (/one_per_day|one_active_per_day/.test(err.constraint ?? '')) {
    return conflict(
      'ALREADY_BOOKED',
      'This patient already has an active booking with this doctor that day',
    );
  }
  return err;
}

/**
 * Books an appointment and issues its queue token in the caller's transaction.
 * source: reception | portal | whatsapp. Retrying with the same idempotency key returns the original.
 */
export async function bookAppointment(trx, org, input) {
  const { patientId, doctorId, slotStart, source, idempotencyKey, userId, contactId, overbook } =
    input;
  if (idempotencyKey) {
    const existing = await trx('appointments')
      .where({ organization_id: org, idempotency_key: idempotencyKey })
      .first();
    if (existing) {
      if (existing.patient_id !== patientId || existing.doctor_id !== doctorId) {
        throw conflict(
          'IDEMPOTENCY_KEY_REUSED',
          'This request key was already used for another booking',
        );
      }
      return { appointmentId: existing.id, replayed: true };
    }
  }
  // Serializes bookings per doctor so slot capacity and tokens stay consistent.
  const doctor = await loadDoctor(trx, org, doctorId, { lock: true });
  if (doctor.status !== 'active')
    throw new AppError(409, 'DOCTOR_INACTIVE', 'This doctor is not taking appointments');
  if (source !== 'reception' && !doctor.online_booking_enabled) {
    throw new AppError(409, 'ONLINE_BOOKING_DISABLED', 'Please book this doctor at the reception');
  }
  const patient = await trx('patients')
    .where({ organization_id: org, id: patientId })
    .first('id', 'status');
  if (!patient) throw notFound('Patient not found');
  if (patient.status !== 'active')
    throw new AppError(409, 'PATIENT_INACTIVE', 'This patient record is not active');

  const start = new Date(slotStart);
  if (Number.isNaN(start.getTime())) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid slot');
  const date = localParts(start, doctor.timezone).date;
  const today = localDate(doctor.timezone);
  const lastDay = addDays(today, source === 'reception' ? 180 : doctor.booking_window_days);
  if (date < today || date > lastDay) {
    throw new AppError(400, 'OUTSIDE_BOOKING_WINDOW', 'This date is not open for booking');
  }
  const { slots, timeOff } = await slotsFor(trx, org, doctor, date);
  if (timeOff !== null)
    throw new AppError(409, 'DOCTOR_UNAVAILABLE', 'The doctor is not available that day');
  const slot = slots.find((s) => s.start === start.toISOString());
  if (!slot) throw new AppError(400, 'INVALID_SLOT', 'This time is not one of the doctor’s slots');
  const pastOrFull = !slot.available;
  if (pastOrFull && !(source === 'reception' && overbook && start > new Date())) {
    throw new AppError(409, 'SLOT_FULL', 'This slot is no longer available. Choose another time.');
  }

  try {
    const [appt] = await trx('appointments')
      .insert({
        organization_id: org,
        branch_id: doctor.branch_id,
        patient_id: patientId,
        doctor_id: doctor.id,
        appointment_date: date,
        slot_start: slot.start,
        slot_end: slot.end,
        source,
        idempotency_key: idempotencyKey ?? null,
        booked_by_user_id: userId ?? null,
        booked_by_contact_id: contactId ?? null,
      })
      .returning('*');
    const token = await nextToken(trx, org, doctor.id, date);
    await trx('queue_entries').insert({
      organization_id: org,
      branch_id: doctor.branch_id,
      doctor_id: doctor.id,
      queue_date: date,
      patient_id: patientId,
      appointment_id: appt.id,
      token_number: token,
      kind: 'appointment',
      status: 'booked',
      tracking_code: newTrackingCode(),
      created_by_user_id: userId ?? null,
    });
    return { appointmentId: appt.id, replayed: false, overbooked: pastOrFull };
  } catch (err) {
    throw translateUnique(err);
  }
}

/** Registers a walk-in for today and issues the next token. */
export async function addWalkIn(
  trx,
  org,
  { patientId, doctorId, priority = 0, priorityReason, idempotencyKey, userId },
) {
  if (idempotencyKey) {
    const existing = await trx('queue_entries')
      .where({ organization_id: org, idempotency_key: idempotencyKey })
      .first('id');
    if (existing) return { entryId: existing.id, replayed: true };
  }
  const doctor = await loadDoctor(trx, org, doctorId, { lock: true });
  if (doctor.status !== 'active')
    throw new AppError(409, 'DOCTOR_INACTIVE', 'This doctor is not active');
  const patient = await trx('patients')
    .where({ organization_id: org, id: patientId })
    .first('status');
  if (!patient) throw notFound('Patient not found');
  if (patient.status !== 'active')
    throw new AppError(409, 'PATIENT_INACTIVE', 'This patient record is not active');
  const date = localDate(doctor.timezone);
  try {
    const token = await nextToken(trx, org, doctor.id, date);
    const [entry] = await trx('queue_entries')
      .insert({
        organization_id: org,
        branch_id: doctor.branch_id,
        doctor_id: doctor.id,
        queue_date: date,
        patient_id: patientId,
        token_number: token,
        kind: 'walk_in',
        status: 'waiting',
        priority,
        priority_reason: priority ? priorityReason : null,
        tracking_code: newTrackingCode(),
        idempotency_key: idempotencyKey ?? null,
        checked_in_at: trx.fn.now(),
        created_by_user_id: userId ?? null,
      })
      .returning('id');
    return { entryId: entry.id, replayed: false };
  } catch (err) {
    throw translateUnique(err);
  }
}

const APPOINTMENT_STATUS_FOR = {
  waiting: 'checked_in',
  completed: 'completed',
  no_show: 'no_show',
  cancelled: 'cancelled',
};

/** Applies a queue action (check_in, call, start, complete, no_show, cancel, requeue). */
export async function transition(trx, org, entry, action, { reason } = {}) {
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(entry.status)) {
    throw new AppError(
      409,
      'INVALID_QUEUE_ACTION',
      `Can't ${action.replace('_', ' ')} a ${entry.status.replace('_', ' ')} entry`,
    );
  }
  if (action === 'check_in') {
    const doctor = await loadDoctor(trx, org, entry.doctor_id);
    if (entry.queue_date !== localDate(doctor.timezone)) {
      throw new AppError(
        409,
        'NOT_TODAY',
        'Patients can only be checked in on the appointment day',
      );
    }
  }
  const stamp = {
    check_in: 'checked_in_at',
    call: 'called_at',
    start: 'started_at',
    complete: 'completed_at',
  }[action];
  const patch = { status: rule.to, updated_at: trx.fn.now() };
  if (stamp) patch[stamp] = trx.fn.now();
  if (action === 'start' && !entry.called_at) patch.called_at = trx.fn.now();
  const [updated] = await trx('queue_entries')
    .where({ organization_id: org, id: entry.id })
    .update(patch)
    .returning('*');
  const apptStatus = APPOINTMENT_STATUS_FOR[rule.to];
  if (entry.appointment_id && (apptStatus || action === 'requeue')) {
    await trx('appointments')
      .where({ organization_id: org, id: entry.appointment_id })
      .update({
        status: action === 'requeue' ? 'checked_in' : apptStatus,
        cancel_reason: action === 'cancel' ? (reason ?? null) : undefined,
        cancelled_at: action === 'cancel' ? trx.fn.now() : undefined,
        updated_at: trx.fn.now(),
      });
  }
  return updated;
}

/** Live status for one queue entry (used by the patient tracking link and patient site). */
export async function trackingStatus(trx, org, entry) {
  const doctor = await loadDoctor(trx, org, entry.doctor_id);
  const all = await trx('queue_entries')
    .where({ organization_id: org, doctor_id: entry.doctor_id, queue_date: entry.queue_date })
    .select('id', 'status', 'priority', 'token_number', 'called_at', 'started_at', 'completed_at');
  const pos = queuePosition(all, entry.id, doctor.consultation_minutes);
  const appt = entry.appointment_id
    ? await trx('appointments')
        .where({ organization_id: org, id: entry.appointment_id })
        .first('slot_start', 'slot_end')
    : null;
  const today = localDate(doctor.timezone);
  return {
    token: entry.token_number,
    date: entry.queue_date,
    isToday: entry.queue_date === today,
    slotStart: appt?.slot_start ?? null,
    slotEnd: appt?.slot_end ?? null,
    doctor: { name: doctor.display_name },
    branch: { name: doctor.branch_name },
    status: entry.status,
    nowServingToken: entry.queue_date === today ? pos.nowServingToken : null,
    ahead: entry.queue_date === today ? pos.ahead : null,
    estimatedWaitMinutes: entry.queue_date === today ? pos.estimatedWaitMinutes : null,
    estimateIsApproximate: true,
    updatedAt: new Date().toISOString(),
  };
}
