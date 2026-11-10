import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { withTenant } from '../../core/db.js';
import { requirePermission } from '../staff-access/permissions.js';

/**
 * Writes an audit entry. Call it inside the same tenant transaction as the change it records, so the
 * change and its audit entry are saved (or rolled back) together.
 */
export async function recordAudit(trx, entry) {
  await trx('audit_logs').insert({
    organization_id: entry.organizationId,
    actor_user_id: entry.actorUserId ?? null,
    action: entry.action,
    entity_type: entry.entityType ?? null,
    entity_id: entry.entityId ?? null,
    reason: entry.reason ?? null,
    metadata: entry.metadata ?? {},
    ip: entry.ip ?? null,
    request_id: entry.requestId ?? null,
  });
}

/** Builds the common audit fields from an authenticated request. */
export const auditContext = (req) => ({
  organizationId: req.auth.organizationId,
  actorUserId: req.auth.userId,
  ip: req.ip ?? null,
  requestId: req.id,
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime({ offset: true }).optional(),
  action: z.string().max(100).optional(),
});

export function auditRouter({ db }) {
  const router = Router();

  router.get('/', requirePermission('audit.read'), async (req, res) => {
    const q = validate(listQuery, req.query);
    const rows = await withTenant(db, req.auth.organizationId, (trx) => {
      const query = trx('audit_logs as a')
        .leftJoin('users as u', 'u.id', 'a.actor_user_id')
        .where('a.organization_id', req.auth.organizationId)
        .select(
          'a.id',
          'a.action',
          'a.entity_type',
          'a.entity_id',
          'a.reason',
          'a.metadata',
          'a.created_at',
          'u.full_name as actor_name',
        )
        .orderBy([
          { column: 'a.created_at', order: 'desc' },
          { column: 'a.id', order: 'desc' },
        ])
        .limit(q.limit);
      if (q.before) query.where('a.created_at', '<', q.before);
      if (q.action) query.where('a.action', q.action);
      return query;
    });
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        reason: r.reason,
        metadata: r.metadata,
        actorName: r.actor_name,
        createdAt: r.created_at,
      })),
      nextBefore: rows.length === q.limit ? rows[rows.length - 1].created_at : null,
    });
  });

  return router;
}
