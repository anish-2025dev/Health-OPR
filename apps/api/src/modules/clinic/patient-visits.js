import { AppError } from '../../core/errors.js';

/**
 * Keeps bookings and queue tokens consistent when a patient record stops being usable.
 *
 * - Deactivating a patient cancels their open bookings and queue tokens (nothing is deleted; the
 *   history stays).
 * - Merging a duplicate moves its open bookings and tokens to the kept record. A booking or token
 *   that would clash with one the kept record already holds (same doctor, same day) is cancelled.
 *
 * Both refuse while the patient is with a doctor, so a consultation is never cut off.
 */
const OPEN_APPOINTMENT = ['booked', 'checked_in'];
const OPEN_ENTRY = ['booked', 'waiting', 'called'];
const ACTIVE_ENTRY = [...OPEN_ENTRY, 'in_consultation'];

async function refuseIfInConsultation(trx, org, patientId) {
  const busy = await trx('queue_entries')
    .where({ organization_id: org, patient_id: patientId, status: 'in_consultation' })
    .first('id');
  if (busy) {
    throw new AppError(
      409,
      'PATIENT_IN_CONSULTATION',
      'This patient is with a doctor now. Finish the consultation first.',
    );
  }
}

const cancelAppointments = (trx, org, ids, reason) =>
  ids.length
    ? trx('appointments').where({ organization_id: org }).whereIn('id', ids).update({
        status: 'cancelled',
        cancel_reason: reason,
        cancelled_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      })
    : 0;

const cancelEntries = (trx, org, ids) =>
  ids.length
    ? trx('queue_entries')
        .where({ organization_id: org })
        .whereIn('id', ids)
        .update({ status: 'cancelled', updated_at: trx.fn.now() })
    : 0;

/** Cancels every open booking and queue token of a patient. Returns the counts. */
export async function cancelOpenVisits(trx, org, patientId, reason) {
  await refuseIfInConsultation(trx, org, patientId);
  const appts = await trx('appointments')
    .where({ organization_id: org, patient_id: patientId })
    .whereIn('status', OPEN_APPOINTMENT)
    .forUpdate()
    .pluck('id');
  const entries = await trx('queue_entries')
    .where({ organization_id: org, patient_id: patientId })
    .whereIn('status', OPEN_ENTRY)
    .forUpdate()
    .pluck('id');
  await cancelEntries(trx, org, entries);
  await cancelAppointments(trx, org, appts, reason);
  return { appointments: appts.length, queueEntries: entries.length };
}

/** Moves open bookings and tokens from a merged record to the kept one. Returns the counts. */
export async function moveOpenVisits(trx, org, fromId, toId) {
  await refuseIfInConsultation(trx, org, fromId);
  const reason = 'Duplicate booking after the patient records were merged';
  const moved = { appointments: 0, queueEntries: 0, cancelled: 0 };

  const appts = await trx('appointments')
    .where({ organization_id: org, patient_id: fromId })
    .whereIn('status', OPEN_APPOINTMENT)
    .forUpdate()
    .select('id', 'doctor_id', 'appointment_date');
  for (const a of appts) {
    const entry = await trx('queue_entries')
      .where({ organization_id: org, appointment_id: a.id })
      .forUpdate()
      .first('id', 'status', 'queue_date');
    const clash =
      (await trx('appointments')
        .where({
          organization_id: org,
          patient_id: toId,
          doctor_id: a.doctor_id,
          appointment_date: a.appointment_date,
        })
        .whereIn('status', OPEN_APPOINTMENT)
        .first('id')) ||
      (entry &&
        (await trx('queue_entries')
          .where({
            organization_id: org,
            patient_id: toId,
            doctor_id: a.doctor_id,
            queue_date: entry.queue_date,
          })
          .whereIn('status', ACTIVE_ENTRY)
          .first('id')));
    if (clash) {
      await cancelAppointments(trx, org, [a.id], reason);
      if (entry && OPEN_ENTRY.includes(entry.status)) await cancelEntries(trx, org, [entry.id]);
      moved.cancelled += 1;
      continue;
    }
    await trx('appointments')
      .where({ organization_id: org, id: a.id })
      .update({ patient_id: toId, updated_at: trx.fn.now() });
    if (entry) {
      await trx('queue_entries')
        .where({ organization_id: org, id: entry.id })
        .update({ patient_id: toId, updated_at: trx.fn.now() });
    }
    moved.appointments += 1;
  }

  // Walk-ins have no appointment.
  const walkIns = await trx('queue_entries')
    .where({ organization_id: org, patient_id: fromId })
    .whereNull('appointment_id')
    .whereIn('status', OPEN_ENTRY)
    .forUpdate()
    .select('id', 'doctor_id', 'queue_date');
  for (const e of walkIns) {
    const clash = await trx('queue_entries')
      .where({
        organization_id: org,
        patient_id: toId,
        doctor_id: e.doctor_id,
        queue_date: e.queue_date,
      })
      .whereIn('status', ACTIVE_ENTRY)
      .first('id');
    if (clash) {
      await cancelEntries(trx, org, [e.id]);
      moved.cancelled += 1;
    } else {
      await trx('queue_entries')
        .where({ organization_id: org, id: e.id })
        .update({ patient_id: toId, updated_at: trx.fn.now() });
      moved.queueEntries += 1;
    }
  }
  return moved;
}
