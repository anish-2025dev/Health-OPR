import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { isUuid, withTenant } from '../../core/db.js';
import { notFound, forbidden, conflict } from '../../core/errors.js';
import { recordAudit } from '../audit/index.js';
import { PERMISSIONS } from '../staff-access/permissions.js';

const P = PERMISSIONS;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const requestShiftChangeSchema = z
  .object({
    requestType: z.enum(['temporary', 'permanent', 'swap']),
    requestedShiftId: z.string().uuid().optional(),
    swapWithEmployeeId: z.string().uuid().optional(),
    effectiveFrom: DATE.optional(),
    effectiveTo: DATE.optional(),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict()
  .refine(
    (v) => {
      if (v.requestType === 'temporary') return Boolean(v.effectiveFrom && v.requestedShiftId);
      if (v.requestType === 'permanent') return Boolean(v.requestedShiftId);
      if (v.requestType === 'swap') return Boolean(v.swapWithEmployeeId);
      return true;
    },
    { message: 'Missing required parameters for the specified shift request type' },
  );

const decideShiftChangeSchema = z
  .object({
    status: z.enum(['approved', 'rejected']),
    decisionComment: z.string().trim().max(1000).optional(),
  })
  .strict();

function presentShiftRequest(r) {
  return {
    id: r.id,
    requestType: r.request_type,
    currentShift: r.current_shift_id
      ? { id: r.current_shift_id, name: r.current_shift_name }
      : null,
    requestedShift: r.requested_shift_id
      ? { id: r.requested_shift_id, name: r.requested_shift_name }
      : null,
    swapWithEmployee: r.swap_with_employee_id
      ? {
          id: r.swap_with_employee_id,
          fullName: r.swap_employee_name,
          employeeNumber: r.swap_employee_number,
        }
      : null,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    reason: r.reason,
    status: r.status,
    employee: {
      id: r.employee_id,
      fullName: r.employee_name,
      employeeNumber: r.employee_number,
      department: r.department_name,
      branchId: r.branch_id,
    },
    decidedBy: r.decided_by_user_id ? { id: r.decided_by_user_id, fullName: r.decider_name } : null,
    decidedAt: r.decided_at,
    decisionComment: r.decision_comment,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function baseQuery(trx, orgId) {
  return trx('shift_change_requests as r')
    .join('employees as e', 'e.id', 'r.employee_id')
    .leftJoin('departments as d', 'd.id', 'e.department_id')
    .leftJoin('shifts as s1', 's1.id', 'r.current_shift_id')
    .leftJoin('shifts as s2', 's2.id', 'r.requested_shift_id')
    .leftJoin('employees as e2', 'e2.id', 'r.swap_with_employee_id')
    .leftJoin('users as u', 'u.id', 'r.decided_by_user_id')
    .where('r.organization_id', orgId)
    .select(
      'r.*',
      'e.full_name as employee_name',
      'e.employee_number',
      'e.branch_id',
      'e.reporting_manager_id',
      'd.name as department_name',
      's1.name as current_shift_name',
      's2.name as requested_shift_name',
      'e2.full_name as swap_employee_name',
      'e2.employee_number as swap_employee_number',
      'u.full_name as decider_name',
    );
}

/**
 * Management router for shift change requests (§8.2).
 */
export function shiftRequestsRouter({ db }) {
  const router = Router();

  router.get('/', async (req, res) => {
    const hasOrgAccess = req.auth.permissions.has(P.SHIFT_REQUESTS_READ);
    const isManager = Boolean(req.auth.employee?.isManager);
    if (!hasOrgAccess && !isManager) throw forbidden();

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

      if (!hasOrgAccess && isManager) {
        query = query.where('e.reporting_manager_id', req.auth.employee.id);
      }
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
        data: rows.map(presentShiftRequest),
      };
    });

    res.json(result);
  });

  router.post('/:id/decide', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const hasOrgAccess = req.auth.permissions.has(P.SHIFT_REQUESTS_MANAGE);
    const isManager = Boolean(req.auth.employee?.isManager);
    if (!hasOrgAccess && !isManager) throw forbidden();

    const body = validate(decideShiftChangeSchema, req.body);
    const orgId = req.auth.organizationId;

    const updated = await withTenant(db, orgId, async (trx) => {
      const r = await baseQuery(trx, orgId).where('r.id', req.params.id).first();
      if (!r) throw notFound('Shift change request not found');

      if (!hasOrgAccess && isManager && r.reporting_manager_id !== req.auth.employee.id) {
        throw forbidden('You can only decide shift requests for your direct reports');
      }
      if (req.auth.branchIds !== null && !req.auth.branchIds.includes(r.branch_id)) {
        throw forbidden();
      }
      if (r.status !== 'pending') {
        throw conflict('ALREADY_DECIDED', 'This shift request has already been decided');
      }

      const patch = {
        status: body.status,
        decision_comment: body.decisionComment || null,
        decided_by_user_id: req.auth.userId,
        decided_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      };

      if (body.status === 'approved') {
        if (r.request_type === 'permanent' && r.requested_shift_id) {
          await trx('employees')
            .where({ organization_id: orgId, id: r.employee_id })
            .update({ shift_id: r.requested_shift_id, updated_at: trx.fn.now() });
        } else if (r.request_type === 'swap' && r.swap_with_employee_id) {
          const swapEmp = await trx('employees')
            .where({ organization_id: orgId, id: r.swap_with_employee_id })
            .first('shift_id');
          if (swapEmp && r.current_shift_id) {
            // Swap shifts between the two employees
            await trx('employees')
              .where({ organization_id: orgId, id: r.employee_id })
              .update({ shift_id: swapEmp.shift_id, updated_at: trx.fn.now() });
            await trx('employees')
              .where({ organization_id: orgId, id: r.swap_with_employee_id })
              .update({ shift_id: r.current_shift_id, updated_at: trx.fn.now() });
          }
        }
      }

      await trx('shift_change_requests')
        .where({ organization_id: orgId, id: req.params.id })
        .update(patch);

      await recordAudit(trx, {
        organizationId: orgId,
        actorUserId: req.auth.userId,
        action: `shift_request.${body.status}`,
        entityType: 'shift_change_request',
        entityId: req.params.id,
        metadata: {
          employeeId: r.employee_id,
          requestType: r.request_type,
          status: body.status,
        },
      });

      return baseQuery(trx, orgId).where('r.id', req.params.id).first();
    });

    res.json(presentShiftRequest(updated));
  });

  return router;
}

/**
 * Normal employee shift dashboard and request submission (§8.1, §8.2).
 */
export function selfShiftRequestsRouter({ db }) {
  const router = Router();

  const requireEmployee = (req) => {
    if (!req.auth.employee) throw notFound('No employee profile linked to this login');
    return req.auth.employee.id;
  };

  // Employee shift dashboard: view current shift & history
  router.get('/current', async (req, res) => {
    const me = requireEmployee(req);
    const orgId = req.auth.organizationId;

    const data = await withTenant(db, orgId, async (trx) => {
      const emp = await trx('employees as e')
        .leftJoin('shifts as s', 's.id', 'e.shift_id')
        .where({ 'e.organization_id': orgId, 'e.id': me })
        .first(
          'e.id',
          'e.full_name',
          'e.weekly_off_days',
          's.id as shift_id',
          's.name as shift_name',
          's.start_time',
          's.end_time',
          's.break_minutes',
        );

      const recentApproved = await baseQuery(trx, orgId)
        .where({ 'r.employee_id': me, 'r.status': 'approved' })
        .orderBy('r.decided_at', 'desc')
        .limit(5);

      return {
        employeeId: emp.id,
        fullName: emp.full_name,
        weeklyOffDays: emp.weekly_off_days,
        currentShift: emp.shift_id
          ? {
              id: emp.shift_id,
              name: emp.shift_name,
              startTime: emp.start_time,
              endTime: emp.end_time,
              breakMinutes: emp.break_minutes,
            }
          : null,
        recentShiftHistory: recentApproved.map(presentShiftRequest),
      };
    });

    res.json(data);
  });

  // Employee list own shift requests
  router.get('/', async (req, res) => {
    const me = requireEmployee(req);
    const orgId = req.auth.organizationId;

    const rows = await withTenant(db, orgId, (trx) =>
      baseQuery(trx, orgId).where('r.employee_id', me).orderBy('r.created_at', 'desc'),
    );

    res.json({ data: rows.map(presentShiftRequest) });
  });

  // Employee apply for shift change
  router.post('/', async (req, res) => {
    const me = requireEmployee(req);
    const body = validate(requestShiftChangeSchema, req.body);
    const orgId = req.auth.organizationId;

    const row = await withTenant(db, orgId, async (trx) => {
      const emp = await trx('employees')
        .where({ organization_id: orgId, id: me })
        .first('shift_id');

      const [created] = await trx('shift_change_requests')
        .insert({
          organization_id: orgId,
          employee_id: me,
          request_type: body.requestType,
          current_shift_id: emp?.shift_id || null,
          requested_shift_id: body.requestedShiftId || null,
          swap_with_employee_id: body.swapWithEmployeeId || null,
          effective_from: body.effectiveFrom || null,
          effective_to: body.effectiveTo || null,
          reason: body.reason,
          status: 'pending',
        })
        .returning('*');

      await recordAudit(trx, {
        organizationId: orgId,
        actorUserId: req.auth.userId,
        action: 'shift_request.submitted',
        entityType: 'shift_change_request',
        entityId: created.id,
        metadata: { requestType: body.requestType, employeeId: me },
      });

      return baseQuery(trx, orgId).where('r.id', created.id).first();
    });

    res.status(201).json(presentShiftRequest(row));
  });

  return router;
}
