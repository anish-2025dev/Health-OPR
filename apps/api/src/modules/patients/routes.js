import { Router } from 'express';
import { cancelOpenVisits } from '../clinic/patient-visits.js';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { isUuid, withTenant } from '../../core/db.js';
import { AppError, notFound } from '../../core/errors.js';
import { maskMobile, mobileSchema } from '../../core/phone.js';
import { auditContext, recordAudit } from '../audit/index.js';
import { PERMISSIONS, requirePermission } from '../staff-access/permissions.js';
import {
  CONSENT_KEYS,
  RELATIONSHIPS,
  currentConsents,
  flagDuplicates,
  insertPatient,
  linkContact,
  possibleDuplicates,
  presentConsents,
  recordConsents,
  upsertContact,
} from './service.js';

const P = PERMISSIONS;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const GENDERS = ['female', 'male', 'other', 'undisclosed'];

const notInFuture = (d) => !d || d <= new Date().toISOString().slice(0, 10);
const demographics = {
  fullName: z.string().trim().min(2).max(200),
  dateOfBirth: DATE.refine(notInFuture, 'Date of birth cannot be in the future').nullable(),
  gender: z.enum(GENDERS).nullable(),
  email: z.string().trim().toLowerCase().email().max(254).nullable(),
  address: z.string().trim().max(500).nullable(),
};

export const consentChoicesSchema = z
  .object({
    whatsappService: z.boolean().default(false),
    smsService: z.boolean().default(false),
    marketing: z.boolean().default(false),
  })
  .strict();

const registerSchema = z
  .object({
    ...demographics,
    dateOfBirth: demographics.dateOfBirth.optional().default(null),
    gender: demographics.gender.optional().default(null),
    email: demographics.email.optional().default(null),
    address: demographics.address.optional().default(null),
    branchId: z.string().uuid(),
    phone: mobileSchema,
    relationship: z.enum(RELATIONSHIPS).default('self'),
    privacyNoticeAcknowledged: z.literal(true, {
      error: 'The patient must acknowledge the privacy notice',
    }),
    consents: consentChoicesSchema.default({}),
    confirmNotDuplicate: z.boolean().default(false),
  })
  .strict();

const updateSchema = z
  .object({
    ...Object.fromEntries(Object.entries(demographics).map(([k, v]) => [k, v.optional()])),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .strict();

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  phone: z.string().trim().max(20).optional(),
  status: z.enum(['active', 'inactive', 'merged', 'all']).default('active'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const COLUMNS = {
  fullName: 'full_name',
  dateOfBirth: 'date_of_birth',
  gender: 'gender',
  email: 'email',
  address: 'address',
  status: 'status',
};

const toColumns = (body) =>
  Object.fromEntries(
    Object.entries(body)
      .filter(([k]) => COLUMNS[k])
      .map(([k, v]) => [COLUMNS[k], v]),
  );

export function presentPatient(p, auth, { links = [], consents } = {}) {
  const full = auth.permissions.has(P.PATIENTS_MANAGE);
  return {
    id: p.id,
    patientNumber: p.patient_number,
    fullName: p.full_name,
    dateOfBirth: p.date_of_birth,
    gender: p.gender,
    email: full ? p.email : undefined,
    address: full ? p.address : undefined,
    status: p.status,
    mergedIntoPatientId: p.merged_into_patient_id,
    registrationSource: p.registration_source,
    registeredBranch: p.registered_branch_id
      ? { id: p.registered_branch_id, name: p.branch_name ?? null }
      : null,
    contacts: links.map((l) => ({
      linkId: l.id,
      contactId: l.contact_id,
      phone: full ? l.phone_e164 : maskMobile(l.phone_e164),
      phoneVerified: Boolean(l.phone_verified_at),
      relationship: l.relationship,
      authorizationStatus: l.authorization_status,
      createdVia: l.created_via,
    })),
    consents: consents ? presentConsents(consents) : undefined,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

const patientQuery = (trx, org) =>
  trx('patients as p')
    .leftJoin('branches as b', 'b.id', 'p.registered_branch_id')
    .where('p.organization_id', org)
    .select('p.*', 'b.name as branch_name');

export const linksQuery = (trx, org) =>
  trx('contact_patient_links as l')
    .join('contacts as c', 'c.id', 'l.contact_id')
    .where('l.organization_id', org)
    .select('l.*', 'c.phone_e164', 'c.phone_verified_at')
    .orderBy('l.created_at');

async function loadPatient(trx, org, id) {
  if (!isUuid(id)) throw notFound('Patient not found');
  const p = await patientQuery(trx, org).where('p.id', id).first();
  if (!p) throw notFound('Patient not found');
  return p;
}

async function loadDetail(trx, org, p, auth) {
  const links = await linksQuery(trx, org).where('l.patient_id', p.id);
  const consents = (await currentConsents(trx, org, [p.id]))[p.id] ?? {};
  return presentPatient(p, auth, { links, consents });
}

const consentChoices = (body) =>
  Object.fromEntries(
    Object.entries(body)
      .filter(([k]) => CONSENT_KEYS[k])
      .map(([k, v]) => [CONSENT_KEYS[k], v]),
  );

export function patientsRouter({ db }) {
  const router = Router();

  // ------------------------------------------------------------------ search
  router.get('/', requirePermission(P.PATIENTS_READ), async (req, res) => {
    const q = validate(listQuery, req.query);
    const org = req.auth.organizationId;
    const { rows, total, links } = await withTenant(db, org, async (trx) => {
      const query = patientQuery(trx, org);
      if (q.status !== 'all') query.where('p.status', q.status);
      if (q.q) {
        const term = `%${q.q.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`;
        query.where((w) =>
          w
            .whereRaw('lower(p.full_name) LIKE ?', [term])
            .orWhereRaw('lower(p.patient_number) LIKE ?', [term]),
        );
      }
      if (q.phone) {
        const digits = q.phone.replace(/\D/g, '').slice(-10);
        if (digits.length < 4)
          throw new AppError(400, 'VALIDATION_ERROR', 'Enter at least 4 digits');
        query.whereExists(
          trx('contact_patient_links as l')
            .join('contacts as c', 'c.id', 'l.contact_id')
            .whereRaw('l.patient_id = p.id')
            .where('l.organization_id', org)
            .whereNot('l.authorization_status', 'revoked')
            .where('c.phone_e164', 'like', `%${digits}`),
        );
      }
      const countQuery = query.clone().clearSelect().clearOrder().count({ n: 'p.id' }).first();
      const [rows, count] = await Promise.all([
        query.orderBy('p.full_name').limit(q.limit).offset(q.offset),
        countQuery,
      ]);
      const links = rows.length
        ? await linksQuery(trx, org).whereIn(
            'l.patient_id',
            rows.map((r) => r.id),
          )
        : [];
      return { rows, total: Number(count.n), links };
    });
    res.json({
      data: rows.map((p) =>
        presentPatient(p, req.auth, { links: links.filter((l) => l.patient_id === p.id) }),
      ),
      total,
      limit: q.limit,
      offset: q.offset,
    });
  });

  // Family links registered through the portal wait here until staff check the relationship.
  router.get('/links/pending', requirePermission(P.PATIENTS_MANAGE), async (req, res) => {
    const org = req.auth.organizationId;
    const rows = await withTenant(db, org, (trx) =>
      linksQuery(trx, org)
        .join('patients as p', 'p.id', 'l.patient_id')
        .where('l.authorization_status', 'pending')
        .select('p.full_name', 'p.patient_number', 'p.date_of_birth'),
    );
    res.json({
      data: rows.map((l) => ({
        linkId: l.id,
        patient: {
          id: l.patient_id,
          patientNumber: l.patient_number,
          fullName: l.full_name,
          dateOfBirth: l.date_of_birth,
        },
        phone: l.phone_e164,
        phoneVerified: Boolean(l.phone_verified_at),
        relationship: l.relationship,
        createdVia: l.created_via,
        createdAt: l.created_at,
      })),
    });
  });

  // ------------------------------------------------------------------ reception registration
  router.post('/', requirePermission(P.PATIENTS_MANAGE), async (req, res) => {
    const body = validate(registerSchema, req.body);
    const org = req.auth.organizationId;
    const created = await withTenant(db, org, async (trx) => {
      const branch = await trx('branches')
        .where({ organization_id: org, id: body.branchId, status: 'active' })
        .first('id');
      const inScope = req.auth.branchIds === null || req.auth.branchIds.includes(body.branchId);
      if (!branch || !inScope) throw new AppError(400, 'VALIDATION_ERROR', 'Unknown branch');

      const contact = await upsertContact(trx, org, body.phone);
      const matches = await possibleDuplicates(trx, org, {
        fullName: body.fullName,
        dateOfBirth: body.dateOfBirth,
        contactIds: [contact.id],
      });
      if (matches.length && !body.confirmNotDuplicate) {
        const found = await trx('patients')
          .where({ organization_id: org })
          .whereIn(
            'id',
            matches.map((m) => m.patientId),
          )
          .select('id', 'patient_number', 'full_name', 'date_of_birth');
        throw new AppError(
          409,
          'POSSIBLE_DUPLICATE',
          'This person may already be registered. Check the matches before creating a new record.',
          {
            matches: matches.map((m) => {
              const p = found.find((f) => f.id === m.patientId);
              return {
                patientId: m.patientId,
                patientNumber: p.patient_number,
                fullName: p.full_name,
                dateOfBirth: p.date_of_birth,
                score: m.score,
                reasons: m.reasons,
              };
            }),
          },
        );
      }

      const patient = await insertPatient(trx, org, {
        ...toColumns(body),
        registered_branch_id: body.branchId,
        registration_source: 'reception',
        created_by_user_id: req.auth.userId,
      });
      // Staff saw the person at the desk, so the relationship is authorized now.
      await linkContact(trx, org, {
        contact_id: contact.id,
        patient_id: patient.id,
        relationship: body.relationship,
        authorization_status: 'authorized',
        authorized_by_user_id: req.auth.userId,
        authorized_at: trx.fn.now(),
        created_via: 'reception',
      });
      await recordConsents(
        trx,
        org,
        patient.id,
        { privacy_notice: true, ...consentChoices(body.consents) },
        {
          channel: 'reception',
          source: 'reception_assisted',
          actorUserId: req.auth.userId,
          actingContactId: contact.id,
          actingRelationship: body.relationship,
        },
      );
      await flagDuplicates(trx, org, patient.id, matches);
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'patient.registered',
        entityType: 'patient',
        entityId: patient.id,
        metadata: { channel: 'reception', possibleDuplicates: matches.length },
      });
      return loadDetail(trx, org, await loadPatient(trx, org, patient.id), req.auth);
    });
    res.status(201).json(created);
  });

  // ------------------------------------------------------------------ profile
  router.get('/:id', requirePermission(P.PATIENTS_READ), async (req, res) => {
    const org = req.auth.organizationId;
    const detail = await withTenant(db, org, async (trx) =>
      loadDetail(trx, org, await loadPatient(trx, org, req.params.id), req.auth),
    );
    res.json(detail);
  });

  router.patch('/:id', requirePermission(P.PATIENTS_MANAGE), async (req, res) => {
    const body = validate(updateSchema, req.body);
    const org = req.auth.organizationId;
    const detail = await withTenant(db, org, async (trx) => {
      const p = await loadPatient(trx, org, req.params.id);
      if (p.status === 'merged') {
        throw new AppError(409, 'PATIENT_MERGED', 'This record was merged; edit the kept record');
      }
      // An inactive patient keeps their history but leaves every queue and future booking.
      const cancelled =
        body.status === 'inactive' && p.status !== 'inactive'
          ? await cancelOpenVisits(trx, org, p.id, 'Patient record set to inactive')
          : null;
      await trx('patients')
        .where({ organization_id: org, id: p.id })
        .update({ ...toColumns(body), updated_at: trx.fn.now() });
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'patient.updated',
        entityType: 'patient',
        entityId: p.id,
        metadata: { fields: Object.keys(body), ...(cancelled ? { cancelled } : {}) },
      });
      return loadDetail(trx, org, await loadPatient(trx, org, p.id), req.auth);
    });
    res.json(detail);
  });

  // ------------------------------------------------------------------ contacts / family links
  router.post('/:id/contacts', requirePermission(P.PATIENTS_MANAGE), async (req, res) => {
    const body = validate(
      z.object({ phone: mobileSchema, relationship: z.enum(RELATIONSHIPS) }).strict(),
      req.body,
    );
    const org = req.auth.organizationId;
    const detail = await withTenant(db, org, async (trx) => {
      const p = await loadPatient(trx, org, req.params.id);
      if (p.status !== 'active')
        throw new AppError(409, 'PATIENT_INACTIVE', 'Patient is not active');
      const contact = await upsertContact(trx, org, body.phone);
      const link = await linkContact(trx, org, {
        contact_id: contact.id,
        patient_id: p.id,
        relationship: body.relationship,
        authorization_status: 'authorized',
        authorized_by_user_id: req.auth.userId,
        authorized_at: trx.fn.now(),
        created_via: 'reception',
      });
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'patient.contact_linked',
        entityType: 'contact_patient_link',
        entityId: link.id,
        metadata: { patientId: p.id, relationship: body.relationship },
      });
      return loadDetail(trx, org, p, req.auth);
    });
    res.status(201).json(detail);
  });

  for (const action of ['authorize', 'revoke']) {
    router.post(
      `/:id/contacts/:linkId/${action}`,
      requirePermission(P.PATIENTS_MANAGE),
      async (req, res) => {
        const body = validate(
          z
            .object({
              reason:
                action === 'revoke'
                  ? z.string().trim().min(3).max(500)
                  : z.string().trim().max(500).optional(),
            })
            .strict(),
          req.body ?? {},
        );
        const org = req.auth.organizationId;
        const detail = await withTenant(db, org, async (trx) => {
          const p = await loadPatient(trx, org, req.params.id);
          if (!isUuid(req.params.linkId)) throw notFound('Link not found');
          const link = await trx('contact_patient_links')
            .where({ organization_id: org, id: req.params.linkId, patient_id: p.id })
            .forUpdate()
            .first();
          if (!link) throw notFound('Link not found');
          if (action === 'authorize' && link.authorization_status !== 'pending') {
            throw new AppError(409, 'LINK_NOT_PENDING', 'Only pending links can be authorized');
          }
          if (action === 'revoke' && link.authorization_status === 'revoked') {
            throw new AppError(409, 'LINK_REVOKED', 'This link is already revoked');
          }
          await trx('contact_patient_links')
            .where({ id: link.id })
            .update(
              action === 'authorize'
                ? {
                    authorization_status: 'authorized',
                    authorized_by_user_id: req.auth.userId,
                    authorized_at: trx.fn.now(),
                  }
                : { authorization_status: 'revoked', revoked_reason: body.reason },
            );
          await recordAudit(trx, {
            ...auditContext(req),
            action: `patient.contact_${action === 'authorize' ? 'authorized' : 'revoked'}`,
            entityType: 'contact_patient_link',
            entityId: link.id,
            reason: body.reason ?? null,
            metadata: { patientId: p.id },
          });
          return loadDetail(trx, org, p, req.auth);
        });
        res.json(detail);
      },
    );
  }

  // ------------------------------------------------------------------ consent
  router.get('/:id/consents', requirePermission(P.PATIENTS_READ), async (req, res) => {
    const org = req.auth.organizationId;
    const rows = await withTenant(db, org, async (trx) => {
      const p = await loadPatient(trx, org, req.params.id);
      return trx('consents as c')
        .leftJoin('privacy_notice_versions as n', 'n.id', 'c.notice_version_id')
        .leftJoin('users as u', 'u.id', 'c.captured_by_user_id')
        .leftJoin('contacts as k', 'k.id', 'c.acting_contact_id')
        .where({ 'c.organization_id': org, 'c.patient_id': p.id })
        .orderBy([
          { column: 'c.captured_at', order: 'desc' },
          { column: 'c.id', order: 'desc' },
        ])
        .select('c.*', 'n.version as notice_version', 'u.full_name as captured_by', 'k.phone_e164');
    });
    res.json({
      data: rows.map((c) => ({
        id: c.id,
        purpose: c.purpose,
        status: c.status,
        channel: c.channel,
        captureSource: c.capture_source,
        noticeVersion: c.notice_version,
        actingRelationship: c.acting_relationship,
        actingPhone: req.auth.permissions.has(P.PATIENTS_MANAGE)
          ? c.phone_e164
          : maskMobile(c.phone_e164),
        capturedBy: c.captured_by,
        capturedAt: c.captured_at,
        withdrawnAt: c.withdrawn_at,
      })),
    });
  });

  router.post('/:id/consents', requirePermission(P.PATIENTS_MANAGE), async (req, res) => {
    const body = validate(
      z
        .object({
          whatsappService: z.boolean().optional(),
          smsService: z.boolean().optional(),
          marketing: z.boolean().optional(),
          privacyNoticeAcknowledged: z.literal(true).optional(),
        })
        .strict()
        .refine((b) => Object.keys(b).length > 0, 'Choose at least one consent to change'),
      req.body,
    );
    const org = req.auth.organizationId;
    const detail = await withTenant(db, org, async (trx) => {
      const p = await loadPatient(trx, org, req.params.id);
      if (p.status === 'merged') throw new AppError(409, 'PATIENT_MERGED', 'Use the kept record');
      const choices = consentChoices(body);
      if (body.privacyNoticeAcknowledged) choices.privacy_notice = true;
      const changed = await recordConsents(trx, org, p.id, choices, {
        channel: 'reception',
        source: 'reception_assisted',
        actorUserId: req.auth.userId,
      });
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'patient.consent_recorded',
        entityType: 'patient',
        entityId: p.id,
        metadata: { choices, changed },
      });
      return loadDetail(trx, org, p, req.auth);
    });
    res.json(detail);
  });

  return router;
}
