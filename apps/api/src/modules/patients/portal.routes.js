import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { isUuid, withSystem, withTenant } from '../../core/db.js';
import { AppError, forbidden, notFound } from '../../core/errors.js';
import { maskMobile } from '../../core/phone.js';
import { rateLimit } from '../../core/rate-limit.js';
import { recordAudit } from '../audit/index.js';
import { membership } from '../patient-accounts/index.js';
import { bookAppointment, loadDoctor, slotsFor, transition } from '../clinic/service.js';
import { localDate } from '../clinic/calc.js';
import { addDays } from '../hr-attendance/calc.js';
import { consentChoicesSchema } from './routes.js';
import {
  selfRegister,
  CONSENT_KEYS,
  RELATIONSHIPS,
  currentConsents,
  presentConsents,
  publishedNotice,
  recordConsents,
} from './service.js';

/**
 * Patient website: one hospital's area (reached at /clinic/<code> on the patient site).
 *
 * - The person signs in with a patient account (phone + OTP, see patient-accounts) and joins the
 *   hospital once with its code; the membership links the account to the hospital's verified contact.
 * - Phone verification is not proof of authority over someone else (spec): family members registered
 *   here stay "pending" until staff authorize the relationship. Pending patients can't be booked or
 *   managed here.
 * - The site never reveals other patients' records. Possible duplicates are flagged for staff.
 */
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const IDEMPOTENCY = /^[A-Za-z0-9_-]{8,100}$/;

const registerSchema = z
  .object({
    fullName: z.string().trim().min(2).max(200),
    dateOfBirth: DATE.refine(
      (d) => d <= new Date().toISOString().slice(0, 10),
      'Date of birth cannot be in the future',
    ),
    gender: z.enum(['female', 'male', 'other', 'undisclosed']).nullable().default(null),
    email: z.string().trim().toLowerCase().email().max(254).nullable().default(null),
    relationship: z.enum(RELATIONSHIPS),
    branchId: z.string().uuid().nullable().default(null),
    privacyNoticeAcknowledged: z.literal(true, {
      error: 'Please read and acknowledge the privacy notice',
    }),
    consents: consentChoicesSchema.default({}),
  })
  .strict();

export function portalRouter({ db, rateLimitStore, authenticatePatient, notifier }) {
  const router = Router();

  async function findOrg(slug) {
    const org = await withSystem(db, (trx) =>
      trx('organizations').where({ slug, status: 'active' }).first('id', 'name', 'slug'),
    );
    if (!org) throw notFound('Hospital not found');
    return org;
  }

  const byIp = rateLimit({
    store: rateLimitStore,
    prefix: 'portal-ip',
    limit: 120,
    windowSec: 15 * 60,
    key: (req) => req.ip ?? 'unknown',
  });

  /** Signed-in patient who has joined this hospital. Sets req.portal = { org, contact }. */
  const portalAuth = [
    authenticatePatient,
    async (req, res, next) => {
      try {
        const org = await findOrg(req.params.slug);
        const m = await membership(db, req.patient.accountId, org.id);
        if (!m) throw forbidden('Join this hospital with its code first');
        const contact = await withTenant(db, org.id, (trx) =>
          trx('contacts').where({ organization_id: org.id, id: m.contact_id }).first(),
        );
        if (!contact) throw forbidden('Join this hospital with its code first');
        req.portal = { org, contact };
        next();
      } catch (err) {
        next(err);
      }
    },
  ];

  // ------------------------------------------------------------------ clinic landing page
  router.get('/:slug', byIp, async (req, res) => {
    const org = await findOrg(req.params.slug);
    const data = await withTenant(db, org.id, async (trx) => ({
      branches: await trx('branches')
        .where({ organization_id: org.id, status: 'active' })
        .orderBy('name')
        .select('id', 'name'),
      notice: await publishedNotice(trx, org.id),
    }));
    res.json({
      organization: { name: org.name, slug: org.slug },
      branches: data.branches,
      privacyNotice: data.notice
        ? {
            id: data.notice.id,
            version: data.notice.version,
            title: data.notice.title,
            content: data.notice.content,
          }
        : null,
    });
  });

  // ------------------------------------------------------------------ the verified person's profiles
  async function linkedPatients(trx, orgId, contactId) {
    const rows = await trx('contact_patient_links as l')
      .join('patients as p', 'p.id', 'l.patient_id')
      .where({ 'l.organization_id': orgId, 'l.contact_id': contactId, 'p.status': 'active' })
      .whereNot('l.authorization_status', 'revoked')
      .orderBy('l.created_at')
      .select(
        'p.id',
        'p.patient_number',
        'p.full_name',
        'l.relationship',
        'l.authorization_status',
      );
    const consents = await currentConsents(
      trx,
      orgId,
      rows.filter((r) => r.authorization_status === 'authorized').map((r) => r.id),
    );
    return rows.map((r) => ({
      id: r.id,
      patientNumber: r.authorization_status === 'authorized' ? r.patient_number : null,
      fullName: r.full_name,
      relationship: r.relationship,
      authorizationStatus: r.authorization_status,
      consents:
        r.authorization_status === 'authorized' ? presentConsents(consents[r.id]) : undefined,
    }));
  }

  router.get('/:slug/me', portalAuth, async (req, res) => {
    const { org, contact } = req.portal;
    const patients = await withTenant(db, org.id, (trx) => linkedPatients(trx, org.id, contact.id));
    res.json({ phone: maskMobile(contact.phone_e164), patients });
  });

  router.post('/:slug/patients', portalAuth, async (req, res) => {
    const body = validate(registerSchema, req.body);
    const { org, contact } = req.portal;
    const result = await withTenant(db, org.id, (trx) =>
      selfRegister(trx, org.id, contact, body, {
        channel: 'portal',
        source: 'clinic_qr_portal',
        ip: req.ip ?? null,
        requestId: req.id,
      }),
    );
    res.status(201).json(result);
  });

  async function authorizedPatient(trx, org, contact, id) {
    if (!isUuid(id)) throw notFound('Patient not found');
    const link = await trx('contact_patient_links as l')
      .join('patients as p', 'p.id', 'l.patient_id')
      .where({
        'l.organization_id': org.id,
        'l.contact_id': contact.id,
        'l.patient_id': id,
        'l.authorization_status': 'authorized',
        'p.status': 'active',
      })
      .first('l.relationship');
    if (!link) throw notFound('Patient not found');
    return link;
  }

  router.post('/:slug/patients/:id/consents', portalAuth, async (req, res) => {
    const body = validate(
      z
        .object({
          whatsappService: z.boolean().optional(),
          smsService: z.boolean().optional(),
          marketing: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    const { org, contact } = req.portal;
    const patients = await withTenant(db, org.id, async (trx) => {
      const link = await authorizedPatient(trx, org, contact, req.params.id);
      const choices = Object.fromEntries(
        Object.entries(body).map(([k, v]) => [CONSENT_KEYS[k], v]),
      );
      await recordConsents(trx, org.id, req.params.id, choices, {
        channel: 'portal',
        source: 'clinic_qr_portal',
        actingContactId: contact.id,
        actingRelationship: link.relationship,
      });
      await recordAudit(trx, {
        organizationId: org.id,
        action: 'patient.consent_recorded',
        entityType: 'patient',
        entityId: req.params.id,
        ip: req.ip ?? null,
        requestId: req.id,
        metadata: { channel: 'portal', choices },
      });
      return linkedPatients(trx, org.id, contact.id);
    });
    res.json({ patients });
  });

  router.post('/:slug/patients/:id/privacy-requests', portalAuth, async (req, res) => {
    const body = validate(
      z
        .object({
          requestType: z.enum(['access', 'correction', 'erasure', 'grievance', 'nomination']),
          details: z.string().trim().min(3).max(2000),
        })
        .strict(),
      req.body,
    );
    const { org, contact } = req.portal;
    const row = await withTenant(db, org.id, async (trx) => {
      await authorizedPatient(trx, org, contact, req.params.id);
      const [created] = await trx('data_principal_requests')
        .insert({
          organization_id: org.id,
          patient_id: req.params.id,
          request_type: body.requestType,
          details: body.details,
          channel: 'portal',
        })
        .returning(['id', 'status']);
      await recordAudit(trx, {
        organizationId: org.id,
        action: 'privacy_request.created',
        entityType: 'data_principal_request',
        entityId: created.id,
        ip: req.ip ?? null,
        requestId: req.id,
        metadata: { channel: 'portal', requestType: body.requestType },
      });
      return created;
    });
    res.status(201).json(row);
  });

  // ------------------------------------------------------------------ online booking
  const onlineDoctors = (trx, orgId) =>
    trx('doctors as d')
      .join('branches as b', 'b.id', 'd.branch_id')
      .where({ 'd.organization_id': orgId, 'd.status': 'active', 'd.online_booking_enabled': true })
      .orderBy('d.display_name')
      .select(
        'd.id',
        'd.display_name',
        'd.specialization',
        'd.booking_window_days',
        'b.name as branch_name',
      );

  router.get('/:slug/doctors', portalAuth, async (req, res) => {
    const { org } = req.portal;
    const rows = await withTenant(db, org.id, (trx) => onlineDoctors(trx, org.id));
    res.json({
      data: rows.map((d) => ({
        id: d.id,
        name: d.display_name,
        specialization: d.specialization,
        branch: d.branch_name,
        bookingWindowDays: d.booking_window_days,
      })),
    });
  });

  router.get('/:slug/doctors/:id/slots', portalAuth, async (req, res) => {
    const { date } = validate(z.object({ date: DATE }), req.query);
    const { org } = req.portal;
    const out = await withTenant(db, org.id, async (trx) => {
      if (!isUuid(req.params.id)) throw notFound('Doctor not found');
      const doctor = await loadDoctor(trx, org.id, req.params.id);
      if (doctor.status !== 'active' || !doctor.online_booking_enabled)
        throw notFound('Doctor not found');
      const today = localDate(doctor.timezone);
      if (date < today || date > addDays(today, doctor.booking_window_days)) {
        return { date, slots: [], open: false };
      }
      const { slots, timeOff } = await slotsFor(trx, org.id, doctor, date);
      // Only open times; how full each slot is stays internal.
      return {
        date,
        open: timeOff === null,
        slots: slots.filter((s) => s.available).map((s) => ({ start: s.start, time: s.time })),
      };
    });
    res.json(out);
  });

  router.post('/:slug/appointments', portalAuth, async (req, res) => {
    const body = validate(
      z
        .object({
          patientId: z.string().uuid(),
          doctorId: z.string().uuid(),
          slotStart: z.string().datetime({ offset: true }),
        })
        .strict(),
      req.body,
    );
    const key = req.get('idempotency-key');
    if (key !== undefined && !IDEMPOTENCY.test(key)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid Idempotency-Key');
    }
    const { org, contact } = req.portal;
    const result = await withTenant(db, org.id, async (trx) => {
      await authorizedPatient(trx, org, contact, body.patientId);
      const r = await bookAppointment(trx, org.id, {
        ...body,
        source: 'portal',
        // Keys are scoped to this contact so one person's key can't collide with another's.
        idempotencyKey: key ? `portal:${contact.id}:${key}` : undefined,
        contactId: contact.id,
      });
      if (!r.replayed) {
        await recordAudit(trx, {
          organizationId: org.id,
          action: 'appointment.booked',
          entityType: 'appointment',
          entityId: r.appointmentId,
          ip: req.ip ?? null,
          requestId: req.id,
          metadata: { channel: 'portal' },
        });
      }
      return {
        ...(await myAppointments(trx, org.id, contact.id)).find((a) => a.id === r.appointmentId),
        replayed: r.replayed,
      };
    });
    const { replayed, ...appointment } = result;
    if (!replayed) notifier?.appointmentBooked(org.id, appointment.id);
    res.status(replayed ? 200 : 201).json(appointment);
  });

  async function myAppointments(trx, orgId, contactId) {
    const rows = await trx('appointments as a')
      .join('contact_patient_links as l', function joinLink() {
        this.on('l.patient_id', 'a.patient_id')
          .andOnVal('l.contact_id', contactId)
          .andOnVal('l.authorization_status', 'authorized');
      })
      .join('patients as p', 'p.id', 'a.patient_id')
      .join('doctors as d', 'd.id', 'a.doctor_id')
      .join('branches as b', 'b.id', 'a.branch_id')
      .leftJoin('queue_entries as q', 'q.appointment_id', 'a.id')
      .where('a.organization_id', orgId)
      .orderBy('a.slot_start', 'desc')
      .limit(100)
      .select(
        'a.id',
        'a.appointment_date',
        'a.slot_start',
        'a.status',
        'p.id as patient_id',
        'p.full_name',
        'd.display_name',
        'b.name as branch_name',
        'q.token_number',
        'q.tracking_code',
        'q.status as queue_status',
      );
    return rows.map((a) => ({
      id: a.id,
      date: a.appointment_date,
      slotStart: a.slot_start,
      status: a.status,
      patient: { id: a.patient_id, fullName: a.full_name },
      doctor: a.display_name,
      branch: a.branch_name,
      token: a.token_number,
      queueStatus: a.queue_status,
      trackingCode: a.tracking_code,
    }));
  }

  router.get('/:slug/appointments', portalAuth, async (req, res) => {
    const { org, contact } = req.portal;
    res.json({
      data: await withTenant(db, org.id, (trx) => myAppointments(trx, org.id, contact.id)),
    });
  });

  router.post('/:slug/appointments/:id/cancel', portalAuth, async (req, res) => {
    const { org, contact } = req.portal;
    const data = await withTenant(db, org.id, async (trx) => {
      if (!isUuid(req.params.id)) throw notFound('Appointment not found');
      const mine = (await myAppointments(trx, org.id, contact.id)).find(
        (a) => a.id === req.params.id,
      );
      if (!mine) throw notFound('Appointment not found');
      if (mine.status !== 'booked')
        throw new AppError(
          409,
          'CANNOT_CANCEL',
          'Only upcoming appointments can be cancelled here',
        );
      const entry = await trx('queue_entries')
        .where({ organization_id: org.id, appointment_id: mine.id })
        .forUpdate()
        .first();
      await transition(trx, org.id, entry, 'cancel', { reason: 'Cancelled by patient online' });
      await recordAudit(trx, {
        organizationId: org.id,
        action: 'appointment.cancelled',
        entityType: 'appointment',
        entityId: mine.id,
        reason: 'Cancelled by patient online',
        ip: req.ip ?? null,
        requestId: req.id,
      });
      return myAppointments(trx, org.id, contact.id);
    });
    res.json({ data });
  });

  return router;
}
