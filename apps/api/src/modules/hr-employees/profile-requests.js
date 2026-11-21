import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { isUuid, withTenant } from '../../core/db.js';
import { notFound, forbidden, conflict } from '../../core/errors.js';
import { recordAudit } from '../audit/index.js';
import { PERMISSIONS, requirePermission } from '../staff-access/permissions.js';

const P = PERMISSIONS;

const changeRequestSchema = z
  .object({
    changes: z
      .record(z.string(), z.any())
      .refine((obj) => Object.keys(obj).length > 0, 'Must specify at least one field to update'),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();

const decideRequestSchema = z
  .object({
    status: z.enum(['approved', 'rejected']),
    decisionComment: z.string().trim().max(1000).optional(),
  })
  .strict();

function presentRequest(r) {
  return {
    id: r.id,
    employee: r.employee_id
      ? {
          id: r.employee_id,
          fullName: r.employee_name,
          employeeNumber: r.employee_number,
          department: r.department_name,
          branchId: r.branch_id,
        }
      : null,
    changes: r.changes,
    reason: r.reason,
    status: r.status,
    decidedBy: r.decided_by_user_id
      ? {
          id: r.decided_by_user_id,
          fullName: r.decider_name,
        }
      : null,
    decidedAt: r.decided_at,
    decisionComment: r.decision_comment,
    appliedChanges: r.applied_changes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function baseQuery(trx, orgId) {
  return trx('profile_update_requests as r')
    .join('employees as e', 'e.id', 'r.employee_id')
    .leftJoin('departments as d', 'd.id', 'e.department_id')
    .leftJoin('users as u', 'u.id', 'r.decided_by_user_id')
    .where('r.organization_id', orgId)
    .select(
      'r.*',
      'e.full_name as employee_name',
      'e.employee_number',
      'e.branch_id',
      'd.name as department_name',
      'u.full_name as decider_name',
    );
}

/**
 * HR Profile Update Requests router (§7.2).
 */
export function hrProfileRequestsRouter({ db }) {
  const router = Router();

  router.get('/', requirePermission(P.PROFILE_REQUESTS_READ), async (req, res) => {
    const q = validate(
      z.object({
        status: z.enum(['pending', 'approved', 'rejected', 'all']).default('all'),
        employeeId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );

    const orgId = req.auth.organizationId;
    const result = await withTenant(db, orgId, async (trx) => {
      let query = baseQuery(trx, orgId);
      if (req.auth.branchIds !== null) {
        query = query.whereIn('e.branch_id', req.auth.branchIds);
      }
      if (q.status !== 'all') {
        query = query.where('r.status', q.status);
      }
      if (q.employeeId) {
        query = query.where('r.employee_id', q.employeeId);
      }

      const countResult = await query.clone().clearSelect().count({ total: '*' }).first();
      const rows = await query.orderBy('r.created_at', 'desc').limit(q.limit).offset(q.offset);

      return {
        total: Number(countResult?.total ?? 0),
        data: rows.map(presentRequest),
      };
    });

    res.json(result);
  });

  router.get('/:id', requirePermission(P.PROFILE_REQUESTS_READ), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const orgId = req.auth.organizationId;

    const row = await withTenant(db, orgId, async (trx) => {
      const r = await baseQuery(trx, orgId).where('r.id', req.params.id).first();
      if (!r) throw notFound('Profile update request not found');
      if (req.auth.branchIds !== null && !req.auth.branchIds.includes(r.branch_id)) {
        throw forbidden();
      }
      return r;
    });

    res.json(presentRequest(row));
  });

  router.post('/:id/decide', requirePermission(P.PROFILE_REQUESTS_MANAGE), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body = validate(decideRequestSchema, req.body);
    const orgId = req.auth.organizationId;

    const updated = await withTenant(db, orgId, async (trx) => {
      const r = await baseQuery(trx, orgId).where('r.id', req.params.id).first();
      if (!r) throw notFound('Profile update request not found');
      if (req.auth.branchIds !== null && !req.auth.branchIds.includes(r.branch_id)) {
        throw forbidden();
      }
      if (r.status !== 'pending') {
        throw conflict('ALREADY_DECIDED', 'This request has already been decided');
      }

      const patch = {
        status: body.status,
        decision_comment: body.decisionComment || null,
        decided_by_user_id: req.auth.userId,
        decided_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      };

      if (body.status === 'approved') {
        // Apply allowable profile modifications to employee record
        const allowedColumns = {
          fullName: 'full_name',
          email: 'email',
          emergencyContactName: 'emergency_contact_name',
          emergencyContactPhone: 'emergency_contact_phone',
        };
        const employeePatch = {};
        for (const [key, col] of Object.entries(allowedColumns)) {
          if (r.changes[key] !== undefined) {
            employeePatch[col] = r.changes[key];
          }
        }
        if (Object.keys(employeePatch).length > 0) {
          employeePatch.updated_at = trx.fn.now();
          await trx('employees')
            .where({ organization_id: orgId, id: r.employee_id })
            .update(employeePatch);
          patch.applied_changes = employeePatch;
        }
      }

      await trx('profile_update_requests')
        .where({ organization_id: orgId, id: req.params.id })
        .update(patch);

      await recordAudit(trx, {
        organizationId: orgId,
        actorUserId: req.auth.userId,
        action: `profile_request.${body.status}`,
        entityType: 'profile_update_request',
        entityId: req.params.id,
        metadata: {
          employeeId: r.employee_id,
          status: body.status,
          applied: Boolean(patch.applied_changes),
        },
      });

      return baseQuery(trx, orgId).where('r.id', req.params.id).first();
    });

    res.json(presentRequest(updated));
  });

  return router;
}

/**
 * Normal Employee Self-service profile update requests (§7.2).
 */
export function selfProfileRequestsRouter({ db }) {
  const router = Router();

  const requireEmployee = (req) => {
    if (!req.auth.employee) throw notFound('No employee profile linked to this login');
    return req.auth.employee.id;
  };

  router.get('/', async (req, res) => {
    const me = requireEmployee(req);
    const orgId = req.auth.organizationId;

    const rows = await withTenant(db, orgId, (trx) =>
      baseQuery(trx, orgId).where('r.employee_id', me).orderBy('r.created_at', 'desc'),
    );

    res.json({ data: rows.map(presentRequest) });
  });

  router.post('/', async (req, res) => {
    const me = requireEmployee(req);
    const body = validate(changeRequestSchema, req.body);
    const orgId = req.auth.organizationId;

    const row = await withTenant(db, orgId, async (trx) => {
      const [created] = await trx('profile_update_requests')
        .insert({
          organization_id: orgId,
          employee_id: me,
          changes: JSON.stringify(body.changes),
          reason: body.reason,
          status: 'pending',
        })
        .returning('*');

      await recordAudit(trx, {
        organizationId: orgId,
        actorUserId: req.auth.userId,
        action: 'profile_request.submitted',
        entityType: 'profile_update_request',
        entityId: created.id,
        metadata: { employeeId: me },
      });

      return baseQuery(trx, orgId).where('r.id', created.id).first();
    });

    res.status(201).json(presentRequest(row));
  });

  return router;
}
