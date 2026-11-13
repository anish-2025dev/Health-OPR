import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { isUuid, withTenant } from '../../core/db.js';
import { AppError, conflict, notFound } from '../../core/errors.js';
import { auditContext, recordAudit } from '../audit/index.js';
import { PERMISSIONS, requirePermission } from '../staff-access/permissions.js';
import { loadPatientSettings } from './service.js';
import { moveOpenVisits } from '../clinic/patient-visits.js';

const P = PERMISSIONS;

const noticeSchema = z
  .object({
    version: z.string().trim().min(1).max(30),
    language: z
      .string()
      .trim()
      .regex(/^[a-z]{2}$/)
      .default('en'),
    title: z.string().trim().min(3).max(200),
    content: z.string().trim().min(20).max(50000),
  })
  .strict();

const presentNotice = (n) => ({
  id: n.id,
  version: n.version,
  language: n.language,
  title: n.title,
  content: n.content,
  status: n.status,
  publishedAt: n.published_at,
  createdAt: n.created_at,
});

const REQUEST_TYPES = ['access', 'correction', 'erasure', 'grievance', 'nomination'];
const REQUEST_STATUSES = ['open', 'in_progress', 'completed', 'rejected'];

export function privacyRouter({ db }) {
  const router = Router();
  const manage = requirePermission(P.PRIVACY_MANAGE);

  // ------------------------------------------------------------------ privacy notice versions
  router.get('/notices', requirePermission(P.PATIENTS_READ), async (req, res) => {
    const org = req.auth.organizationId;
    const rows = await withTenant(db, org, (trx) =>
      trx('privacy_notice_versions').where({ organization_id: org }).orderBy('created_at', 'desc'),
    );
    res.json({ data: rows.map(presentNotice) });
  });

  router.post('/notices', manage, async (req, res) => {
    const body = validate(noticeSchema, req.body);
    const org = req.auth.organizationId;
    const row = await withTenant(db, org, async (trx) => {
      let created;
      try {
        [created] = await trx('privacy_notice_versions')
          .insert({ ...body, organization_id: org, created_by_user_id: req.auth.userId })
          .returning('*');
      } catch (err) {
        if (err.code === '23505') throw conflict('VERSION_EXISTS', 'This version already exists');
        throw err;
      }
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'privacy_notice.created',
        entityType: 'privacy_notice',
        entityId: created.id,
        metadata: { version: body.version },
      });
      return created;
    });
    res.status(201).json(presentNotice(row));
  });

  const loadNotice = async (trx, org, id) => {
    if (!isUuid(id)) throw notFound('Notice not found');
    const n = await trx('privacy_notice_versions')
      .where({ organization_id: org, id })
      .forUpdate()
      .first();
    if (!n) throw notFound('Notice not found');
    return n;
  };

  // Published wording is evidence for consents already given, so only drafts can change.
  router.patch('/notices/:id', manage, async (req, res) => {
    const body = validate(noticeSchema.partial().strict(), req.body);
    const org = req.auth.organizationId;
    const row = await withTenant(db, org, async (trx) => {
      const n = await loadNotice(trx, org, req.params.id);
      if (n.status !== 'draft') {
        throw new AppError(
          409,
          'NOTICE_LOCKED',
          'Published notices cannot be edited; create a new version',
        );
      }
      const [updated] = await trx('privacy_notice_versions')
        .where({ id: n.id })
        .update(body)
        .returning('*');
      return updated;
    });
    res.json(presentNotice(row));
  });

  router.post('/notices/:id/publish', manage, async (req, res) => {
    const org = req.auth.organizationId;
    const row = await withTenant(db, org, async (trx) => {
      const n = await loadNotice(trx, org, req.params.id);
      if (n.status !== 'draft')
        throw new AppError(409, 'NOTICE_NOT_DRAFT', 'Only drafts can be published');
      await trx('privacy_notice_versions')
        .where({ organization_id: org, language: n.language, status: 'published' })
        .update({ status: 'retired' });
      const [published] = await trx('privacy_notice_versions')
        .where({ id: n.id })
        .update({ status: 'published', published_at: trx.fn.now() })
        .returning('*');
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'privacy_notice.published',
        entityType: 'privacy_notice',
        entityId: n.id,
        metadata: { version: n.version, language: n.language },
      });
      return published;
    });
    res.json(presentNotice(row));
  });

  router.delete('/notices/:id', manage, async (req, res) => {
    const org = req.auth.organizationId;
    await withTenant(db, org, async (trx) => {
      const n = await loadNotice(trx, org, req.params.id);
      if (n.status !== 'draft')
        throw new AppError(409, 'NOTICE_LOCKED', 'Only drafts can be deleted');
      await trx('privacy_notice_versions').where({ id: n.id }).delete();
    });
    res.status(204).end();
  });

  // ------------------------------------------------------------------ matching settings
  router.get('/settings', manage, async (req, res) => {
    const org = req.auth.organizationId;
    res.json(await withTenant(db, org, (trx) => loadPatientSettings(trx, org)));
  });

  router.put('/settings', manage, async (req, res) => {
    const body = validate(
      z
        .object({
          nameSimilarityThreshold: z.number().min(0.5).max(1),
          matchRequiresDob: z.boolean(),
        })
        .strict(),
      req.body,
    );
    const org = req.auth.organizationId;
    const out = await withTenant(db, org, async (trx) => {
      await trx('patient_settings')
        .insert({
          organization_id: org,
          name_similarity_threshold: body.nameSimilarityThreshold,
          match_requires_dob: body.matchRequiresDob,
        })
        .onConflict('organization_id')
        .merge({
          name_similarity_threshold: body.nameSimilarityThreshold,
          match_requires_dob: body.matchRequiresDob,
          updated_at: trx.fn.now(),
        });
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'patient_settings.updated',
        entityType: 'patient_settings',
        metadata: body,
      });
      return loadPatientSettings(trx, org);
    });
    res.json(out);
  });

  // ------------------------------------------------------------------ duplicate review
  router.get('/duplicates', manage, async (req, res) => {
    const q = validate(
      z.object({ status: z.enum(['open', 'not_duplicate', 'duplicate']).default('open') }),
      req.query,
    );
    const org = req.auth.organizationId;
    const rows = await withTenant(db, org, (trx) =>
      trx('patient_duplicate_flags as f')
        .join('patients as a', 'a.id', 'f.patient_id')
        .join('patients as b', 'b.id', 'f.candidate_patient_id')
        .where({ 'f.organization_id': org, 'f.status': q.status })
        .orderBy('f.created_at', 'desc')
        .limit(200)
        .select(
          'f.*',
          'a.patient_number as a_number',
          'a.full_name as a_name',
          'a.date_of_birth as a_dob',
          'a.status as a_status',
          'b.patient_number as b_number',
          'b.full_name as b_name',
          'b.date_of_birth as b_dob',
          'b.status as b_status',
        ),
    );
    const side = (r, k, id) => ({
      id,
      patientNumber: r[`${k}_number`],
      fullName: r[`${k}_name`],
      dateOfBirth: r[`${k}_dob`],
      status: r[`${k}_status`],
    });
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        patient: side(r, 'a', r.patient_id),
        candidate: side(r, 'b', r.candidate_patient_id),
        score: Number(r.score),
        reasons: r.reasons,
        status: r.status,
        decidedAt: r.decided_at,
        createdAt: r.created_at,
      })),
    });
  });

  /**
   * A person decides; nothing is merged automatically. Merging keeps one record, marks the other as
   * merged into it (it is never deleted) and moves its phone links to the kept record.
   */
  router.post('/duplicates/:id/decide', manage, async (req, res) => {
    const body = validate(
      z
        .object({
          decision: z.enum(['not_duplicate', 'duplicate']),
          keepPatientId: z.string().uuid().optional(),
          reason: z.string().trim().min(3).max(500),
        })
        .strict()
        .refine((b) => b.decision !== 'duplicate' || b.keepPatientId, {
          message: 'Choose which record to keep',
          path: ['keepPatientId'],
        }),
      req.body,
    );
    const org = req.auth.organizationId;
    const out = await withTenant(db, org, async (trx) => {
      if (!isUuid(req.params.id)) throw notFound('Review item not found');
      const flag = await trx('patient_duplicate_flags')
        .where({ organization_id: org, id: req.params.id })
        .forUpdate()
        .first();
      if (!flag) throw notFound('Review item not found');
      if (flag.status !== 'open') throw new AppError(409, 'ALREADY_DECIDED', 'Already decided');

      let merged = null;
      if (body.decision === 'duplicate') {
        const pair = [flag.patient_id, flag.candidate_patient_id];
        if (!pair.includes(body.keepPatientId)) {
          throw new AppError(400, 'VALIDATION_ERROR', 'Keep one of the two records under review');
        }
        const removeId = pair.find((id) => id !== body.keepPatientId);
        const patients = await trx('patients')
          .where({ organization_id: org })
          .whereIn('id', pair)
          .forUpdate()
          .select('id', 'status');
        if (patients.some((p) => p.status === 'merged')) {
          throw new AppError(409, 'PATIENT_MERGED', 'One of these records was already merged');
        }
        const links = await trx('contact_patient_links')
          .where({ organization_id: org, patient_id: removeId })
          .whereNot('authorization_status', 'revoked');
        if (links.length) {
          await trx('contact_patient_links')
            .insert(
              links.map((l) => ({
                organization_id: org,
                contact_id: l.contact_id,
                patient_id: body.keepPatientId,
                relationship: l.relationship,
                authorization_status: l.authorization_status,
                authorized_by_user_id: l.authorized_by_user_id,
                authorized_at: l.authorized_at,
                created_via: l.created_via,
              })),
            )
            .onConflict(['contact_id', 'patient_id'])
            .ignore();
        }
        await trx('contact_patient_links')
          .where({ organization_id: org, patient_id: removeId })
          .whereNot('authorization_status', 'revoked')
          .update({
            authorization_status: 'revoked',
            revoked_reason: 'merged into another record',
          });
        await trx('patients').where({ organization_id: org, id: removeId }).update({
          status: 'merged',
          merged_into_patient_id: body.keepPatientId,
          updated_at: trx.fn.now(),
        });
        // Other open reviews involving the merged record are no longer meaningful.
        await trx('patient_duplicate_flags')
          .where({ organization_id: org, status: 'open' })
          .whereNot('id', flag.id)
          .where((w) => w.where('patient_id', removeId).orWhere('candidate_patient_id', removeId))
          .update({
            status: 'not_duplicate',
            decided_by_user_id: req.auth.userId,
            decided_at: trx.fn.now(),
          });
        // Bookings and queue tokens follow the person to the kept record.
        const visits = await moveOpenVisits(trx, org, removeId, body.keepPatientId);
        merged = { keptPatientId: body.keepPatientId, mergedPatientId: removeId, visits };
      }
      await trx('patient_duplicate_flags').where({ id: flag.id }).update({
        status: body.decision,
        decided_by_user_id: req.auth.userId,
        decided_at: trx.fn.now(),
      });
      await recordAudit(trx, {
        ...auditContext(req),
        action: body.decision === 'duplicate' ? 'patient.merged' : 'patient.duplicate_dismissed',
        entityType: 'patient_duplicate_flag',
        entityId: flag.id,
        reason: body.reason,
        metadata: merged ?? {},
      });
      return { id: flag.id, status: body.decision, merged };
    });
    res.json(out);
  });

  // ------------------------------------------------------------------ data principal requests
  router.get('/requests', manage, async (req, res) => {
    const q = validate(
      z.object({ status: z.enum([...REQUEST_STATUSES, 'all']).default('all') }),
      req.query,
    );
    const org = req.auth.organizationId;
    const rows = await withTenant(db, org, (trx) => {
      const query = trx('data_principal_requests as r')
        .join('patients as p', 'p.id', 'r.patient_id')
        .where('r.organization_id', org)
        .orderBy('r.created_at', 'desc')
        .limit(200)
        .select('r.*', 'p.full_name', 'p.patient_number');
      if (q.status !== 'all') query.where('r.status', q.status);
      return query;
    });
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        patient: { id: r.patient_id, fullName: r.full_name, patientNumber: r.patient_number },
        requestType: r.request_type,
        details: r.details,
        channel: r.channel,
        status: r.status,
        resolution: r.resolution,
        resolvedAt: r.resolved_at,
        createdAt: r.created_at,
      })),
    });
  });

  router.post('/requests', requirePermission(P.PATIENTS_MANAGE), async (req, res) => {
    const body = validate(
      z
        .object({
          patientId: z.string().uuid(),
          requestType: z.enum(REQUEST_TYPES),
          details: z.string().trim().min(3).max(2000),
        })
        .strict(),
      req.body,
    );
    const org = req.auth.organizationId;
    const row = await withTenant(db, org, async (trx) => {
      const p = await trx('patients')
        .where({ organization_id: org, id: body.patientId })
        .first('id');
      if (!p) throw notFound('Patient not found');
      const [created] = await trx('data_principal_requests')
        .insert({
          organization_id: org,
          patient_id: p.id,
          request_type: body.requestType,
          details: body.details,
          channel: 'reception',
          created_by_user_id: req.auth.userId,
        })
        .returning('*');
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'privacy_request.created',
        entityType: 'data_principal_request',
        entityId: created.id,
        metadata: { requestType: body.requestType },
      });
      return created;
    });
    res.status(201).json({ id: row.id, status: row.status });
  });

  router.patch('/requests/:id', manage, async (req, res) => {
    const body = validate(
      z
        .object({
          status: z.enum(['in_progress', 'completed', 'rejected']),
          resolution: z.string().trim().min(3).max(2000).optional(),
        })
        .strict()
        .refine((b) => b.status === 'in_progress' || b.resolution, {
          message: 'Describe the outcome',
          path: ['resolution'],
        }),
      req.body,
    );
    const org = req.auth.organizationId;
    const row = await withTenant(db, org, async (trx) => {
      if (!isUuid(req.params.id)) throw notFound('Request not found');
      const r = await trx('data_principal_requests')
        .where({ organization_id: org, id: req.params.id })
        .forUpdate()
        .first();
      if (!r) throw notFound('Request not found');
      if (['completed', 'rejected'].includes(r.status)) {
        throw new AppError(409, 'REQUEST_CLOSED', 'This request is closed');
      }
      const done = body.status !== 'in_progress';
      const [updated] = await trx('data_principal_requests')
        .where({ id: r.id })
        .update({
          status: body.status,
          resolution: body.resolution ?? r.resolution,
          resolved_by_user_id: done ? req.auth.userId : null,
          resolved_at: done ? trx.fn.now() : null,
        })
        .returning('*');
      await recordAudit(trx, {
        ...auditContext(req),
        action: `privacy_request.${body.status}`,
        entityType: 'data_principal_request',
        entityId: r.id,
      });
      return updated;
    });
    res.json({ id: row.id, status: row.status, resolution: row.resolution });
  });

  return router;
}
