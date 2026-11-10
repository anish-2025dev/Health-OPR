import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { isUuid, withSystem, withTenant } from '../../core/db.js';
import { AppError, forbidden, notFound } from '../../core/errors.js';
import { rateLimit } from '../../core/rate-limit.js';
import { auditContext, recordAudit } from '../audit/index.js';
import { PERMISSIONS, requirePermission } from '../staff-access/permissions.js';
import { ACTIVE_QUEUE_STATUSES, localDate, queueOrder, queuePosition } from './calc.js';
import {
  addWalkIn,
  bookAppointment,
  loadDoctor,
  slotsFor,
  trackingStatus,
  transition,
} from './service.js';

const P = PERMISSIONS;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const idempotencyKey = (req) => {
  const key = req.get('idempotency-key');
  if (key === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Idempotency-Key must be 8–100 letters, digits, - or _',
    );
  }
  return key;
};

const inBranchScope = (auth, branchId) =>
  auth.branchIds === null || auth.branchIds.includes(branchId);

/**
 * Who may act on a doctor's queue: appointment managers and nurses within their branch scope; a doctor
 * (without broader roles) only on their own queue.
 */
function assertQueueAccess(auth, doctor) {
  if (!inBranchScope(auth, doctor.branch_id)) throw notFound('Doctor not found');
  if (auth.permissions.has(P.APPOINTMENTS_MANAGE)) return;
  const onlyDoctor = auth.roleKeys.includes('doctor') && !auth.roleKeys.includes('nurse');
  if (onlyDoctor && doctor.user_id !== auth.userId)
    throw forbidden('You can manage only your own queue');
}

// ======================================================================== doctors
const doctorFields = {
  displayName: z.string().trim().min(2).max(200),
  branchId: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  departmentId: z.string().uuid().nullable(),
  specialization: z.string().trim().max(200).nullable(),
  consultationMinutes: z.number().int().min(2).max(240),
  bookingWindowDays: z.number().int().min(0).max(180),
  onlineBookingEnabled: z.boolean(),
  status: z.enum(['active', 'inactive']),
};
const DOCTOR_COLUMNS = {
  displayName: 'display_name',
  branchId: 'branch_id',
  userId: 'user_id',
  departmentId: 'department_id',
  specialization: 'specialization',
  consultationMinutes: 'consultation_minutes',
  bookingWindowDays: 'booking_window_days',
  onlineBookingEnabled: 'online_booking_enabled',
  status: 'status',
};
const doctorColumns = (body) =>
  Object.fromEntries(Object.entries(body).map(([k, v]) => [DOCTOR_COLUMNS[k], v]));

export const presentDoctor = (d) => ({
  id: d.id,
  displayName: d.display_name,
  specialization: d.specialization,
  branch: { id: d.branch_id, name: d.branch_name ?? null },
  department: d.department_id ? { id: d.department_id, name: d.department_name ?? null } : null,
  userId: d.user_id,
  consultationMinutes: d.consultation_minutes,
  bookingWindowDays: d.booking_window_days,
  onlineBookingEnabled: d.online_booking_enabled,
  status: d.status,
});

const doctorsQuery = (trx, org) =>
  trx('doctors as d')
    .join('branches as b', 'b.id', 'd.branch_id')
    .leftJoin('departments as dep', 'dep.id', 'd.department_id')
    .where('d.organization_id', org)
    .select('d.*', 'b.name as branch_name', 'b.timezone', 'dep.name as department_name');

async function assertDoctorRefs(trx, org, auth, values) {
  if (values.branch_id) {
    const b = await trx('branches')
      .where({ organization_id: org, id: values.branch_id })
      .first('id');
    if (!b || !inBranchScope(auth, values.branch_id))
      throw new AppError(400, 'VALIDATION_ERROR', 'Unknown branch');
  }
  if (values.department_id) {
    const d = await trx('departments')
      .where({ organization_id: org, id: values.department_id })
      .first('id');
    if (!d) throw new AppError(400, 'VALIDATION_ERROR', 'Unknown department');
  }
  if (values.user_id) {
    const u = await trx('users').where({ organization_id: org, id: values.user_id }).first('id');
    if (!u) throw new AppError(400, 'VALIDATION_ERROR', 'Unknown user');
  }
}

const sessionSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: TIME,
    endTime: TIME,
    slotMinutes: z.number().int().min(5).max(240),
    patientsPerSlot: z.number().int().min(1).max(50).default(1),
  })
  .strict()
  .refine((s) => s.endTime > s.startTime, { message: 'End time must be after start time' });

export function doctorsRouter({ db }) {
  const router = Router();

  router.get('/', requirePermission(P.APPOINTMENTS_READ), async (req, res) => {
    const q = validate(
      z.object({
        branchId: z.string().uuid().optional(),
        status: z.enum(['active', 'inactive', 'all']).default('active'),
      }),
      req.query,
    );
    const org = req.auth.organizationId;
    const rows = await withTenant(db, org, (trx) => {
      const query = doctorsQuery(trx, org).orderBy('d.display_name');
      if (q.status !== 'all') query.where('d.status', q.status);
      if (q.branchId) query.where('d.branch_id', q.branchId);
      if (req.auth.branchIds !== null) query.whereIn('d.branch_id', req.auth.branchIds);
      return query;
    });
    res.json({ data: rows.map(presentDoctor) });
  });

  router.post('/', requirePermission(P.DOCTORS_MANAGE), async (req, res) => {
    const body = validate(
      z
        .object({
          ...doctorFields,
          userId: doctorFields.userId.optional(),
          departmentId: doctorFields.departmentId.optional(),
          specialization: doctorFields.specialization.optional(),
          consultationMinutes: doctorFields.consultationMinutes.default(10),
          bookingWindowDays: doctorFields.bookingWindowDays.default(14),
          onlineBookingEnabled: doctorFields.onlineBookingEnabled.default(true),
          status: doctorFields.status.default('active'),
        })
        .strict(),
      req.body,
    );
    const org = req.auth.organizationId;
    const row = await withTenant(db, org, async (trx) => {
      const values = doctorColumns(body);
      await assertDoctorRefs(trx, org, req.auth, values);
      let created;
      try {
        [created] = await trx('doctors')
          .insert({ ...values, organization_id: org })
          .returning('id');
      } catch (err) {
        if (err.code === '23505')
          throw new AppError(409, 'USER_ALREADY_DOCTOR', 'This user is already linked to a doctor');
        throw err;
      }
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'doctor.created',
        entityType: 'doctor',
        entityId: created.id,
      });
      return doctorsQuery(trx, org).where('d.id', created.id).first();
    });
    res.status(201).json(presentDoctor(row));
  });

  const loadScoped = async (trx, req) => {
    if (!isUuid(req.params.id)) throw notFound('Doctor not found');
    const d = await doctorsQuery(trx, req.auth.organizationId).where('d.id', req.params.id).first();
    if (!d || !inBranchScope(req.auth, d.branch_id)) throw notFound('Doctor not found');
    return d;
  };

  router.get('/:id', requirePermission(P.APPOINTMENTS_READ), async (req, res) => {
    const d = await withTenant(db, req.auth.organizationId, (trx) => loadScoped(trx, req));
    res.json(presentDoctor(d));
  });

  router.patch('/:id', requirePermission(P.DOCTORS_MANAGE), async (req, res) => {
    const body = validate(
      z
        .object(Object.fromEntries(Object.entries(doctorFields).map(([k, v]) => [k, v.optional()])))
        .strict(),
      req.body,
    );
    const org = req.auth.organizationId;
    const row = await withTenant(db, org, async (trx) => {
      const d = await loadScoped(trx, req);
      const values = doctorColumns(body);
      await assertDoctorRefs(trx, org, req.auth, values);
      if (values.branch_id && values.branch_id !== d.branch_id) {
        const future = await trx('queue_entries')
          .where({ organization_id: org, doctor_id: d.id })
          .whereIn('status', ACTIVE_QUEUE_STATUSES)
          .first('id');
        if (future)
          throw new AppError(
            409,
            'DOCTOR_HAS_BOOKINGS',
            'Cancel or finish active bookings before moving branch',
          );
      }
      try {
        await trx('doctors')
          .where({ organization_id: org, id: d.id })
          .update({ ...values, updated_at: trx.fn.now() });
      } catch (err) {
        if (err.code === '23505')
          throw new AppError(409, 'USER_ALREADY_DOCTOR', 'This user is already linked to a doctor');
        throw err;
      }
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'doctor.updated',
        entityType: 'doctor',
        entityId: d.id,
        metadata: { fields: Object.keys(body) },
      });
      return doctorsQuery(trx, org).where('d.id', d.id).first();
    });
    res.json(presentDoctor(row));
  });

  router.get('/:id/schedule', requirePermission(P.APPOINTMENTS_READ), async (req, res) => {
    const org = req.auth.organizationId;
    const rows = await withTenant(db, org, async (trx) => {
      const d = await loadScoped(trx, req);
      return trx('doctor_schedules')
        .where({ organization_id: org, doctor_id: d.id })
        .orderBy(['day_of_week', 'start_time']);
    });
    res.json({
      data: rows.map((s) => ({
        dayOfWeek: s.day_of_week,
        startTime: s.start_time.slice(0, 5),
        endTime: s.end_time.slice(0, 5),
        slotMinutes: s.slot_minutes,
        patientsPerSlot: s.patients_per_slot,
      })),
    });
  });

  // Replaces the weekly schedule. Existing bookings are kept; new bookings use the new schedule.
  router.put('/:id/schedule', requirePermission(P.DOCTORS_MANAGE), async (req, res) => {
    const { sessions } = validate(
      z.object({ sessions: z.array(sessionSchema).max(50) }).strict(),
      req.body,
    );
    for (const a of sessions) {
      for (const b of sessions) {
        if (
          a !== b &&
          a.dayOfWeek === b.dayOfWeek &&
          a.startTime < b.endTime &&
          b.startTime < a.endTime
        ) {
          throw new AppError(400, 'SCHEDULE_OVERLAP', 'Sessions on the same day overlap');
        }
      }
    }
    const org = req.auth.organizationId;
    await withTenant(db, org, async (trx) => {
      const d = await loadScoped(trx, req);
      await trx('doctor_schedules').where({ organization_id: org, doctor_id: d.id }).delete();
      if (sessions.length) {
        await trx('doctor_schedules').insert(
          sessions.map((s) => ({
            organization_id: org,
            doctor_id: d.id,
            day_of_week: s.dayOfWeek,
            start_time: s.startTime,
            end_time: s.endTime,
            slot_minutes: s.slotMinutes,
            patients_per_slot: s.patientsPerSlot,
          })),
        );
      }
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'doctor.schedule_updated',
        entityType: 'doctor',
        entityId: d.id,
        metadata: { sessions: sessions.length },
      });
    });
    res.json({ data: sessions });
  });

  router.get('/:id/time-off', requirePermission(P.APPOINTMENTS_READ), async (req, res) => {
    const org = req.auth.organizationId;
    const rows = await withTenant(db, org, async (trx) => {
      const d = await loadScoped(trx, req);
      return trx('doctor_time_off')
        .where({ organization_id: org, doctor_id: d.id })
        .where('date', '>=', localDate(d.timezone))
        .orderBy('date');
    });
    res.json({ data: rows.map((r) => ({ id: r.id, date: r.date, reason: r.reason })) });
  });

  router.post('/:id/time-off', requirePermission(P.DOCTORS_MANAGE), async (req, res) => {
    const body = validate(
      z.object({ date: DATE, reason: z.string().trim().max(200).optional() }).strict(),
      req.body,
    );
    const org = req.auth.organizationId;
    const out = await withTenant(db, org, async (trx) => {
      const d = await loadScoped(trx, req);
      try {
        const [row] = await trx('doctor_time_off')
          .insert({
            organization_id: org,
            doctor_id: d.id,
            date: body.date,
            reason: body.reason ?? null,
          })
          .returning('*');
        // Existing bookings are not cancelled automatically: reception contacts the patients.
        const affected = await trx('appointments')
          .where({ organization_id: org, doctor_id: d.id, appointment_date: body.date })
          .whereIn('status', ['booked', 'checked_in'])
          .count({ n: '*' })
          .first();
        await recordAudit(trx, {
          ...auditContext(req),
          action: 'doctor.time_off_added',
          entityType: 'doctor',
          entityId: d.id,
          metadata: { date: body.date },
        });
        return {
          id: row.id,
          date: row.date,
          reason: row.reason,
          affectedAppointments: Number(affected.n),
        };
      } catch (err) {
        if (err.code === '23505')
          throw new AppError(409, 'ALREADY_OFF', 'Time off already recorded for this date');
        throw err;
      }
    });
    res.status(201).json(out);
  });

  router.delete('/:id/time-off/:offId', requirePermission(P.DOCTORS_MANAGE), async (req, res) => {
    const org = req.auth.organizationId;
    await withTenant(db, org, async (trx) => {
      const d = await loadScoped(trx, req);
      if (!isUuid(req.params.offId)) throw notFound('Not found');
      const n = await trx('doctor_time_off')
        .where({ organization_id: org, doctor_id: d.id, id: req.params.offId })
        .delete();
      if (!n) throw notFound('Not found');
    });
    res.status(204).end();
  });

  router.get('/:id/slots', requirePermission(P.APPOINTMENTS_READ), async (req, res) => {
    const { date } = validate(z.object({ date: DATE }), req.query);
    const org = req.auth.organizationId;
    const out = await withTenant(db, org, async (trx) => {
      const d = await loadScoped(trx, req);
      return slotsFor(trx, org, d, date);
    });
    res.json(out);
  });

  return router;
}

// ======================================================================== appointments
const presentAppointment = (a) => ({
  id: a.id,
  date: a.appointment_date,
  slotStart: a.slot_start,
  slotEnd: a.slot_end,
  status: a.status,
  source: a.source,
  cancelReason: a.cancel_reason,
  patient: { id: a.patient_id, fullName: a.patient_name, patientNumber: a.patient_number },
  doctor: { id: a.doctor_id, displayName: a.doctor_name },
  branch: { id: a.branch_id, name: a.branch_name },
  queue: a.entry_id
    ? {
        entryId: a.entry_id,
        token: a.token_number,
        status: a.entry_status,
        trackingCode: a.tracking_code,
      }
    : null,
  createdAt: a.created_at,
});

export const appointmentsQuery = (trx, org) =>
  trx('appointments as a')
    .join('patients as p', 'p.id', 'a.patient_id')
    .join('doctors as d', 'd.id', 'a.doctor_id')
    .join('branches as b', 'b.id', 'a.branch_id')
    .leftJoin('queue_entries as q', 'q.appointment_id', 'a.id')
    .where('a.organization_id', org)
    .select(
      'a.*',
      'p.full_name as patient_name',
      'p.patient_number',
      'd.display_name as doctor_name',
      'b.name as branch_name',
      'q.id as entry_id',
      'q.token_number',
      'q.status as entry_status',
      'q.tracking_code',
    );

export function appointmentsRouter({ db, notifier }) {
  const router = Router();

  router.get('/', requirePermission(P.APPOINTMENTS_READ), async (req, res) => {
    const q = validate(
      z.object({
        date: DATE.optional(),
        from: DATE.optional(),
        to: DATE.optional(),
        doctorId: z.string().uuid().optional(),
        patientId: z.string().uuid().optional(),
        status: z
          .enum(['booked', 'checked_in', 'completed', 'cancelled', 'no_show', 'all'])
          .default('all'),
      }),
      req.query,
    );
    const org = req.auth.organizationId;
    const rows = await withTenant(db, org, (trx) => {
      const query = appointmentsQuery(trx, org).orderBy('a.slot_start').limit(500);
      if (q.date) query.where('a.appointment_date', q.date);
      if (q.from) query.where('a.appointment_date', '>=', q.from);
      if (q.to) query.where('a.appointment_date', '<=', q.to);
      if (q.doctorId) query.where('a.doctor_id', q.doctorId);
      if (q.patientId) query.where('a.patient_id', q.patientId);
      if (q.status !== 'all') query.where('a.status', q.status);
      if (req.auth.branchIds !== null) query.whereIn('a.branch_id', req.auth.branchIds);
      return query;
    });
    res.json({ data: rows.map(presentAppointment) });
  });

  router.post('/', requirePermission(P.APPOINTMENTS_MANAGE), async (req, res) => {
    const body = validate(
      z
        .object({
          patientId: z.string().uuid(),
          doctorId: z.string().uuid(),
          slotStart: z.string().datetime({ offset: true }),
          overbook: z.boolean().default(false),
        })
        .strict(),
      req.body,
    );
    const key = idempotencyKey(req);
    const org = req.auth.organizationId;
    const { row, replayed } = await withTenant(db, org, async (trx) => {
      const doctor = await loadDoctor(trx, org, body.doctorId);
      if (!inBranchScope(req.auth, doctor.branch_id)) throw notFound('Doctor not found');
      const r = await bookAppointment(trx, org, {
        ...body,
        source: 'reception',
        idempotencyKey: key,
        userId: req.auth.userId,
      });
      if (!r.replayed) {
        await recordAudit(trx, {
          ...auditContext(req),
          action: r.overbooked ? 'appointment.overbooked' : 'appointment.booked',
          entityType: 'appointment',
          entityId: r.appointmentId,
          metadata: { channel: 'reception' },
        });
      }
      return {
        row: await appointmentsQuery(trx, org).where('a.id', r.appointmentId).first(),
        replayed: r.replayed,
      };
    });
    if (!replayed) notifier?.appointmentBooked(org, row.id);
    res.status(replayed ? 200 : 201).json(presentAppointment(row));
  });

  const loadAppt = async (trx, req) => {
    if (!isUuid(req.params.id)) throw notFound('Appointment not found');
    const a = await trx('appointments')
      .where({ organization_id: req.auth.organizationId, id: req.params.id })
      .forUpdate()
      .first();
    if (!a || !inBranchScope(req.auth, a.branch_id)) throw notFound('Appointment not found');
    return a;
  };

  router.post('/:id/cancel', requirePermission(P.APPOINTMENTS_MANAGE), async (req, res) => {
    const { reason } = validate(
      z.object({ reason: z.string().trim().min(3).max(500) }).strict(),
      req.body,
    );
    const org = req.auth.organizationId;
    const row = await withTenant(db, org, async (trx) => {
      const a = await loadAppt(trx, req);
      const entry = await trx('queue_entries')
        .where({ organization_id: org, appointment_id: a.id })
        .forUpdate()
        .first();
      if (a.status !== 'booked' && a.status !== 'checked_in') {
        throw new AppError(409, 'CANNOT_CANCEL', 'Only upcoming appointments can be cancelled');
      }
      await transition(trx, org, entry, 'cancel', { reason });
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'appointment.cancelled',
        entityType: 'appointment',
        entityId: a.id,
        reason,
      });
      return appointmentsQuery(trx, org).where('a.id', a.id).first();
    });
    res.json(presentAppointment(row));
  });

  router.post('/:id/reschedule', requirePermission(P.APPOINTMENTS_MANAGE), async (req, res) => {
    const body = validate(
      z
        .object({
          slotStart: z.string().datetime({ offset: true }),
          reason: z.string().trim().min(3).max(500),
        })
        .strict(),
      req.body,
    );
    const org = req.auth.organizationId;
    const row = await withTenant(db, org, async (trx) => {
      const a = await loadAppt(trx, req);
      if (a.status !== 'booked')
        throw new AppError(
          409,
          'CANNOT_RESCHEDULE',
          'Only appointments not yet checked in can be moved',
        );
      const entry = await trx('queue_entries')
        .where({ organization_id: org, appointment_id: a.id })
        .forUpdate()
        .first();
      await transition(trx, org, entry, 'cancel', { reason: `Rescheduled: ${body.reason}` });
      const r = await bookAppointment(trx, org, {
        patientId: a.patient_id,
        doctorId: a.doctor_id,
        slotStart: body.slotStart,
        source: 'reception',
        userId: req.auth.userId,
      });
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'appointment.rescheduled',
        entityType: 'appointment',
        entityId: r.appointmentId,
        reason: body.reason,
        metadata: { previousAppointmentId: a.id },
      });
      return appointmentsQuery(trx, org).where('a.id', r.appointmentId).first();
    });
    res.status(201).json(presentAppointment(row));
  });

  return router;
}

// ======================================================================== queue
const entriesQuery = (trx, org) =>
  trx('queue_entries as q')
    .join('patients as p', 'p.id', 'q.patient_id')
    .leftJoin('appointments as a', 'a.id', 'q.appointment_id')
    .where('q.organization_id', org)
    .select('q.*', 'p.full_name as patient_name', 'p.patient_number', 'a.slot_start');

const presentEntry = (e) => ({
  id: e.id,
  token: e.token_number,
  kind: e.kind,
  status: e.status,
  priority: e.priority,
  priorityReason: e.priority_reason,
  patient: { id: e.patient_id, fullName: e.patient_name, patientNumber: e.patient_number },
  doctorId: e.doctor_id,
  date: e.queue_date,
  slotStart: e.slot_start ?? null,
  appointmentId: e.appointment_id,
  trackingCode: e.tracking_code,
  checkedInAt: e.checked_in_at,
  calledAt: e.called_at,
  startedAt: e.started_at,
  completedAt: e.completed_at,
});

const ACTIONS = {
  'check-in': 'check_in',
  call: 'call',
  start: 'start',
  complete: 'complete',
  'no-show': 'no_show',
  cancel: 'cancel',
  requeue: 'requeue',
};

export function queueRouter({ db }) {
  const router = Router();

  async function board(trx, org, doctor, date) {
    const entries = await entriesQuery(trx, org).where({
      'q.doctor_id': doctor.id,
      'q.queue_date': date,
    });
    entries.sort((a, b) => {
      const order = (e) => (ACTIVE_QUEUE_STATUSES.includes(e.status) ? 0 : 1);
      return order(a) - order(b) || queueOrder(a, b);
    });
    const count = (s) => entries.filter((e) => e.status === s).length;
    const pos = queuePosition(entries, null, doctor.consultation_minutes);
    return {
      doctor: { id: doctor.id, displayName: doctor.display_name, branchName: doctor.branch_name },
      date,
      isToday: date === localDate(doctor.timezone),
      nowServingToken: pos.nowServingToken,
      averageConsultationMinutes: pos.averageConsultationMinutes,
      counts: {
        booked: count('booked'),
        waiting: count('waiting'),
        called: count('called'),
        inConsultation: count('in_consultation'),
        completed: count('completed'),
        noShow: count('no_show'),
        cancelled: count('cancelled'),
      },
      entries: entries.map(presentEntry),
    };
  }

  router.get('/', requirePermission(P.APPOINTMENTS_READ), async (req, res) => {
    const q = validate(z.object({ doctorId: z.string().uuid(), date: DATE.optional() }), req.query);
    const org = req.auth.organizationId;
    const out = await withTenant(db, org, async (trx) => {
      const doctor = await loadDoctor(trx, org, q.doctorId);
      if (!inBranchScope(req.auth, doctor.branch_id)) throw notFound('Doctor not found');
      return board(trx, org, doctor, q.date ?? localDate(doctor.timezone));
    });
    res.json(out);
  });

  // Clinic dashboard: today's numbers per doctor (Phase 7).
  router.get('/summary', requirePermission(P.APPOINTMENTS_READ), async (req, res) => {
    const q = validate(
      z.object({ date: DATE.optional(), branchId: z.string().uuid().optional() }),
      req.query,
    );
    const org = req.auth.organizationId;
    const out = await withTenant(db, org, async (trx) => {
      const doctors = await doctorsQuery(trx, org)
        .where('d.status', 'active')
        .modify((x) => {
          if (q.branchId) x.where('d.branch_id', q.branchId);
          if (req.auth.branchIds !== null) x.whereIn('d.branch_id', req.auth.branchIds);
        })
        .orderBy('d.display_name');
      const result = [];
      for (const d of doctors) {
        const date = q.date ?? localDate(d.timezone);
        const b = await board(trx, org, d, date);
        const waits = b.entries
          .filter((e) => e.checkedInAt && e.calledAt)
          .map((e) => (new Date(e.calledAt) - new Date(e.checkedInAt)) / 60_000);
        result.push({
          doctor: {
            id: d.id,
            displayName: d.display_name,
            branchName: d.branch_name,
            specialization: d.specialization,
          },
          date,
          nowServingToken: b.nowServingToken,
          counts: b.counts,
          walkIns: b.entries.filter((e) => e.kind === 'walk_in').length,
          averageWaitMinutes: waits.length
            ? Math.round(waits.reduce((s, m) => s + m, 0) / waits.length)
            : null,
          averageConsultationMinutes: b.averageConsultationMinutes,
        });
      }
      return result;
    });
    res.json({ data: out });
  });

  // Visit history for one patient (appointments and walk-ins).
  router.get('/visits', requirePermission(P.APPOINTMENTS_READ), async (req, res) => {
    const { patientId } = validate(z.object({ patientId: z.string().uuid() }), req.query);
    const org = req.auth.organizationId;
    const rows = await withTenant(db, org, (trx) =>
      entriesQuery(trx, org)
        .join('doctors as d', 'd.id', 'q.doctor_id')
        .join('branches as b', 'b.id', 'q.branch_id')
        .where('q.patient_id', patientId)
        .modify((x) => {
          if (req.auth.branchIds !== null) x.whereIn('q.branch_id', req.auth.branchIds);
        })
        .orderBy([
          { column: 'q.queue_date', order: 'desc' },
          { column: 'q.token_number', order: 'desc' },
        ])
        .limit(200)
        .select('d.display_name as doctor_name', 'b.name as branch_name'),
    );
    res.json({
      data: rows.map((e) => ({
        ...presentEntry(e),
        doctorName: e.doctor_name,
        branchName: e.branch_name,
      })),
    });
  });

  router.post('/walk-ins', requirePermission(P.APPOINTMENTS_MANAGE), async (req, res) => {
    const body = validate(
      z
        .object({
          patientId: z.string().uuid(),
          doctorId: z.string().uuid(),
          priority: z.number().int().min(0).max(2).default(0),
          priorityReason: z.string().trim().min(3).max(200).optional(),
        })
        .strict()
        .refine((b) => b.priority === 0 || b.priorityReason, {
          message: 'Give a reason for priority',
          path: ['priorityReason'],
        }),
      req.body,
    );
    const key = idempotencyKey(req);
    const org = req.auth.organizationId;
    const { entry, replayed } = await withTenant(db, org, async (trx) => {
      const doctor = await loadDoctor(trx, org, body.doctorId);
      if (!inBranchScope(req.auth, doctor.branch_id)) throw notFound('Doctor not found');
      const r = await addWalkIn(trx, org, {
        ...body,
        idempotencyKey: key,
        userId: req.auth.userId,
      });
      if (!r.replayed) {
        await recordAudit(trx, {
          ...auditContext(req),
          action: 'queue.walk_in_added',
          entityType: 'queue_entry',
          entityId: r.entryId,
          reason: body.priorityReason,
        });
      }
      return {
        entry: await entriesQuery(trx, org).where('q.id', r.entryId).first(),
        replayed: r.replayed,
      };
    });
    res.status(replayed ? 200 : 201).json(presentEntry(entry));
  });

  const loadEntry = async (trx, req) => {
    if (!isUuid(req.params.id)) throw notFound('Queue entry not found');
    const org = req.auth.organizationId;
    const entry = await trx('queue_entries')
      .where({ organization_id: org, id: req.params.id })
      .forUpdate()
      .first();
    if (!entry) throw notFound('Queue entry not found');
    const doctor = await loadDoctor(trx, org, entry.doctor_id);
    assertQueueAccess(req.auth, doctor);
    return { entry, doctor };
  };

  router.post(
    '/entries/:id/priority',
    requirePermission(P.APPOINTMENTS_MANAGE),
    async (req, res) => {
      const body = validate(
        z
          .object({
            priority: z.number().int().min(0).max(2),
            reason: z.string().trim().min(3).max(200),
          })
          .strict(),
        req.body,
      );
      const org = req.auth.organizationId;
      const entry = await withTenant(db, org, async (trx) => {
        const { entry: e } = await loadEntry(trx, req);
        if (!ACTIVE_QUEUE_STATUSES.includes(e.status))
          throw new AppError(409, 'INVALID_QUEUE_ACTION', 'This entry is closed');
        await trx('queue_entries').where({ id: e.id }).update({
          priority: body.priority,
          priority_reason: body.reason,
          updated_at: trx.fn.now(),
        });
        await recordAudit(trx, {
          ...auditContext(req),
          action: 'queue.priority_changed',
          entityType: 'queue_entry',
          entityId: e.id,
          reason: body.reason,
          metadata: { from: e.priority, to: body.priority },
        });
        return entriesQuery(trx, org).where('q.id', e.id).first();
      });
      res.json(presentEntry(entry));
    },
  );

  router.post('/entries/:id/:action', requirePermission(P.QUEUE_MANAGE), async (req, res) => {
    const action = ACTIONS[req.params.action];
    if (!action) throw notFound('Unknown action');
    const needsReason = action === 'cancel';
    const body = validate(
      z
        .object({
          reason: needsReason
            ? z.string().trim().min(3).max(500)
            : z.string().trim().max(500).optional(),
        })
        .strict(),
      req.body ?? {},
    );
    // Doctors and nurses run the consultation flow; only reception and managers cancel.
    if (action === 'cancel' && !req.auth.permissions.has(P.APPOINTMENTS_MANAGE)) {
      throw new AppError(403, 'FORBIDDEN', 'Ask the reception to cancel');
    }
    const org = req.auth.organizationId;
    const entry = await withTenant(db, org, async (trx) => {
      const { entry: e } = await loadEntry(trx, req);
      const updated = await transition(trx, org, e, action, { reason: body.reason });
      await recordAudit(trx, {
        ...auditContext(req),
        action: `queue.${action}`,
        entityType: 'queue_entry',
        entityId: e.id,
        reason: body.reason ?? null,
      });
      return entriesQuery(trx, org).where('q.id', updated.id).first();
    });
    res.json(presentEntry(entry));
  });

  // Calls the next arrived patient in order (priority, then token).
  router.post('/call-next', requirePermission(P.QUEUE_MANAGE), async (req, res) => {
    const { doctorId } = validate(z.object({ doctorId: z.string().uuid() }).strict(), req.body);
    const org = req.auth.organizationId;
    const entry = await withTenant(db, org, async (trx) => {
      const doctor = await loadDoctor(trx, org, doctorId, { lock: true });
      assertQueueAccess(req.auth, doctor);
      const waiting = await trx('queue_entries')
        .where({
          organization_id: org,
          doctor_id: doctor.id,
          queue_date: localDate(doctor.timezone),
          status: 'waiting',
        })
        .forUpdate();
      const next = waiting.sort(queueOrder)[0];
      if (!next) throw new AppError(409, 'QUEUE_EMPTY', 'No checked-in patients are waiting');
      await transition(trx, org, next, 'call');
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'queue.call',
        entityType: 'queue_entry',
        entityId: next.id,
      });
      return entriesQuery(trx, org).where('q.id', next.id).first();
    });
    res.json(presentEntry(entry));
  });

  // Marks everyone still open on a day as no-show (end of day).
  router.post('/close-day', requirePermission(P.APPOINTMENTS_MANAGE), async (req, res) => {
    const body = validate(z.object({ doctorId: z.string().uuid(), date: DATE }).strict(), req.body);
    const org = req.auth.organizationId;
    const closed = await withTenant(db, org, async (trx) => {
      const doctor = await loadDoctor(trx, org, body.doctorId, { lock: true });
      if (!inBranchScope(req.auth, doctor.branch_id)) throw notFound('Doctor not found');
      if (body.date > localDate(doctor.timezone))
        throw new AppError(400, 'VALIDATION_ERROR', 'Only today or past days can be closed');
      const open = await trx('queue_entries')
        .where({ organization_id: org, doctor_id: doctor.id, queue_date: body.date })
        .whereIn('status', ['booked', 'waiting', 'called'])
        .forUpdate();
      for (const e of open) await transition(trx, org, e, 'no_show');
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'queue.day_closed',
        entityType: 'doctor',
        entityId: doctor.id,
        metadata: { date: body.date, noShows: open.length },
      });
      return open.length;
    });
    res.json({ noShows: closed });
  });

  return router;
}

// ======================================================================== public tracking link
export function trackingRouter({ db, rateLimitStore }) {
  const router = Router();
  const limiter = rateLimit({
    store: rateLimitStore,
    prefix: 'track-ip',
    limit: 300,
    windowSec: 15 * 60,
    key: (req) => req.ip ?? 'unknown',
  });

  // Anyone with the link sees the token and queue position, never the patient's name or details.
  router.get('/:code', limiter, async (req, res) => {
    const code = req.params.code;
    if (!/^[A-Za-z0-9_-]{16}$/.test(code)) throw notFound('Booking not found');
    // Pre-tenant lookup of which clinic the code belongs to; everything else runs in that tenant.
    const ref = await withSystem(db, (trx) =>
      trx('queue_entries as q')
        .join('organizations as o', 'o.id', 'q.organization_id')
        .where({ 'q.tracking_code': code, 'o.status': 'active' })
        .first('q.organization_id', 'o.name as organization_name'),
    );
    if (!ref) throw notFound('Booking not found');
    const status = await withTenant(db, ref.organization_id, async (trx) => {
      const entry = await trx('queue_entries')
        .where({ organization_id: ref.organization_id, tracking_code: code })
        .first();
      return trackingStatus(trx, ref.organization_id, entry);
    });
    res.set('Cache-Control', 'no-store');
    res.json({ clinic: { name: ref.organization_name }, ...status });
  });

  return router;
}
