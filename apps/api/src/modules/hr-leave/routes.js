import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { isUuid, withTenant } from '../../core/db.js';
import { AppError, conflict, forbidden, notFound } from '../../core/errors.js';
import { auditContext, recordAudit } from '../audit/index.js';
import { PERMISSIONS, requirePermission } from '../staff-access/permissions.js';
import { monthEnd } from '../hr-attendance/calc.js';
import { leaveYearOf, leaveYearRange } from './calc.js';
import { assertRangeNotPayrollLocked } from '../hr-payroll/lock.js';
import {
  balancesFor,
  employeeRow,
  leaveSettings,
  lockEmployee,
  presentType,
  todayIn,
  validateApplication,
} from './service.js';

const P = PERMISSIONS;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const UNIQUE = '23505';

const typeSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{1,10}$/, 'Up to 10 letters or digits'),
    isPaid: z.boolean().default(true),
    annualQuota: z.number().min(0).max(365).multipleOf(0.5).default(0),
    accrual: z.enum(['yearly_upfront', 'monthly', 'none']).default('yearly_upfront'),
    carryForwardMax: z.number().min(0).max(365).multipleOf(0.5).default(0),
    allowHalfDay: z.boolean().default(true),
    minNoticeDays: z.number().int().min(0).max(90).default(0),
    maxConsecutiveDays: z.number().int().min(1).max(365).nullable().default(null),
    approvalLevels: z.union([z.literal(1), z.literal(2)]).default(1),
  })
  .strict();
const typeUpdateSchema = typeSchema
  .partial()
  .extend({ status: z.enum(['active', 'inactive']).optional() })
  .strict();

const toTypeColumns = (b) => {
  const map = {
    name: 'name',
    code: 'code',
    isPaid: 'is_paid',
    annualQuota: 'annual_quota',
    accrual: 'accrual',
    carryForwardMax: 'carry_forward_max',
    allowHalfDay: 'allow_half_day',
    minNoticeDays: 'min_notice_days',
    maxConsecutiveDays: 'max_consecutive_days',
    approvalLevels: 'approval_levels',
    status: 'status',
  };
  return Object.fromEntries(
    Object.entries(b)
      .filter(([k]) => map[k])
      .map(([k, v]) => [map[k], v]),
  );
};

const applySchema = z
  .object({
    leaveTypeId: z.string().uuid(),
    startDate: DATE,
    endDate: DATE,
    startHalf: z.boolean().default(false),
    endHalf: z.boolean().default(false),
    reason: z.string().trim().min(3, 'Give a short reason').max(500),
  })
  .strict();

const presentRequest = (r) => ({
  id: r.id,
  employee: r.employee_name
    ? { id: r.employee_id, fullName: r.employee_name, employeeNumber: r.employee_number }
    : { id: r.employee_id },
  leaveType: { id: r.leave_type_id, name: r.type_name, code: r.type_code, isPaid: r.type_is_paid },
  startDate: r.start_date,
  endDate: r.end_date,
  startHalf: r.start_half,
  endHalf: r.end_half,
  days: Number(r.days),
  reason: r.reason,
  status: r.status,
  approvalLevel: r.approval_level,
  approvalLevels: r.type_levels,
  level1By: r.level1_name ?? null,
  decidedBy: r.decider_name ?? null,
  decidedAt: r.decided_at,
  decisionComment: r.decision_comment,
  createdAt: r.created_at,
});

const requestQuery = (trx, organizationId) =>
  trx('leave_requests as r')
    .join('leave_types as t', 't.id', 'r.leave_type_id')
    .join('employees as e', 'e.id', 'r.employee_id')
    .leftJoin('users as u1', 'u1.id', 'r.level1_by_user_id')
    .leftJoin('users as u2', 'u2.id', 'r.decided_by_user_id')
    .where('r.organization_id', organizationId)
    .select(
      'r.*',
      't.name as type_name',
      't.code as type_code',
      't.is_paid as type_is_paid',
      't.approval_levels as type_levels',
      'e.full_name as employee_name',
      'e.employee_number',
      'e.branch_id',
      'e.reporting_manager_id',
      'u1.full_name as level1_name',
      'u2.full_name as decider_name',
    );

const inBranchScope = (auth, branchId) =>
  auth.branchIds === null || auth.branchIds.includes(branchId);
const isHr = (auth, branchId) =>
  auth.permissions.has(P.LEAVE_MANAGE) && inBranchScope(auth, branchId);
const isManagerOf = (auth, reportingManagerId) =>
  Boolean(auth.employee) && reportingManagerId === auth.employee.id;

/** Who may act on a pending request right now. Never the requester themself. */
function canDecide(auth, r) {
  if (auth.employee?.id === r.employee_id) return false;
  if (isHr(auth, r.branch_id)) return true;
  // Level 1 belongs to the reporting manager; level 2 is HR only.
  return r.approval_level === 1 && isManagerOf(auth, r.reporting_manager_id);
}

const requireEmployee = (req, res, next) =>
  req.auth.employee
    ? next()
    : next(
        new AppError(403, 'NO_EMPLOYEE_PROFILE', 'Your login is not linked to an employee profile'),
      );

// ================================================================== employee self-service (/me/leave)

export function selfLeaveRouter({ db }) {
  const router = Router();
  router.use(requireEmployee);

  router.get('/balances', async (req, res) => {
    const q = validate(
      z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }),
      req.query,
    );
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const settings = await leaveSettings(trx, req.auth.organizationId);
      const employee = await employeeRow(trx, req.auth.organizationId, req.auth.employee.id);
      const year = q.year ?? leaveYearOf(todayIn(settings.timeZone), settings.startMonth);
      return {
        year,
        range: leaveYearRange(year, settings.startMonth),
        balances: await balancesFor(trx, {
          organizationId: req.auth.organizationId,
          employee,
          year,
          settings,
        }),
      };
    });
    res.json(result);
  });

  router.get('/requests', async (req, res) => {
    const rows = await withTenant(db, req.auth.organizationId, (trx) =>
      requestQuery(trx, req.auth.organizationId)
        .where('r.employee_id', req.auth.employee.id)
        .orderBy('r.start_date', 'desc')
        .limit(200),
    );
    res.json({ data: rows.map(presentRequest) });
  });

  /** Dry run: days counted and balance after, without saving. */
  router.post('/preview', async (req, res) => {
    const body = validate(applySchema.extend({ reason: z.string().optional() }), req.body);
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const settings = await leaveSettings(trx, req.auth.organizationId);
      const employee = await employeeRow(trx, req.auth.organizationId, req.auth.employee.id);
      const type = await trx('leave_types')
        .where({ organization_id: req.auth.organizationId, id: body.leaveTypeId })
        .first();
      if (!type) throw notFound('Leave type not found');
      return validateApplication(trx, {
        organizationId: req.auth.organizationId,
        employee,
        type,
        body,
        settings,
      });
    });
    res.json(result);
  });

  router.post('/requests', async (req, res) => {
    const body = validate(applySchema, req.body);
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      // Serialize applications per employee so two parallel requests can't both pass the balance check.
      await lockEmployee(trx, req.auth.organizationId, req.auth.employee.id);
      const settings = await leaveSettings(trx, req.auth.organizationId);
      const employee = await employeeRow(trx, req.auth.organizationId, req.auth.employee.id);
      if (!['active', 'on_notice'].includes(employee.employment_status)) {
        throw new AppError(403, 'EMPLOYEE_INACTIVE', 'Your employee profile is not active');
      }
      const type = await trx('leave_types')
        .where({ organization_id: req.auth.organizationId, id: body.leaveTypeId })
        .first();
      if (!type) throw notFound('Leave type not found');
      const { days, year } = await validateApplication(trx, {
        organizationId: req.auth.organizationId,
        employee,
        type,
        body,
        settings,
      });
      await assertRangeNotPayrollLocked(
        trx,
        req.auth.organizationId,
        employee.id,
        body.startDate,
        body.endDate,
      );
      const [created] = await trx('leave_requests')
        .insert({
          organization_id: req.auth.organizationId,
          employee_id: employee.id,
          leave_type_id: type.id,
          start_date: body.startDate,
          end_date: body.endDate,
          start_half: body.startHalf,
          end_half: body.endHalf,
          days,
          leave_year: year,
          reason: body.reason,
        })
        .returning('id');
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'leave.requested',
        entityType: 'leave_request',
        entityId: created.id,
        metadata: { type: type.code, startDate: body.startDate, endDate: body.endDate, days },
      });
      return requestQuery(trx, req.auth.organizationId).where('r.id', created.id).first();
    });
    res.status(201).json(presentRequest(row));
  });

  router.post('/requests/:id/cancel', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      const r = await trx('leave_requests')
        .where({
          organization_id: req.auth.organizationId,
          id: req.params.id,
          employee_id: req.auth.employee.id,
        })
        .forUpdate()
        .first();
      if (!r) throw notFound('Leave request not found');
      const settings = await leaveSettings(trx, req.auth.organizationId);
      const today = todayIn(settings.timeZone);
      if (r.status === 'approved' && r.start_date <= today) {
        throw new AppError(
          409,
          'LEAVE_STARTED',
          'This leave has already started. Ask HR to cancel it.',
        );
      }
      if (!['pending', 'approved'].includes(r.status))
        throw conflict('NOT_CANCELLABLE', 'This request cannot be cancelled');
      await trx('leave_requests').where({ id: r.id }).update({
        status: 'cancelled',
        cancelled_by_user_id: req.auth.userId,
        decided_at: trx.fn.now(),
      });
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'leave.cancelled',
        entityType: 'leave_request',
        entityId: r.id,
      });
      return requestQuery(trx, req.auth.organizationId).where('r.id', r.id).first();
    });
    res.json(presentRequest(row));
  });

  return router;
}

// ================================================================== admin / managers (/leave)

export function leaveRouter({ db }) {
  const router = Router();

  router.get('/types', async (req, res) => {
    const rows = await withTenant(db, req.auth.organizationId, (trx) =>
      trx('leave_types').where({ organization_id: req.auth.organizationId }).orderBy('name'),
    );
    res.json({ data: rows.map(presentType) });
  });

  router.post('/types', requirePermission(P.LEAVE_MANAGE), async (req, res) => {
    const body = validate(typeSchema, req.body);
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      let created;
      try {
        [created] = await trx('leave_types')
          .insert({ organization_id: req.auth.organizationId, ...toTypeColumns(body) })
          .returning('*');
      } catch (err) {
        if (err.code === UNIQUE)
          throw conflict('CODE_TAKEN', 'A leave type with this code already exists');
        throw err;
      }
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'leave.type_created',
        entityType: 'leave_type',
        entityId: created.id,
        metadata: { values: body },
      });
      return created;
    });
    res.status(201).json(presentType(row));
  });

  router.patch('/types/:id', requirePermission(P.LEAVE_MANAGE), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body = validate(typeUpdateSchema, req.body);
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      let updated;
      try {
        [updated] = await trx('leave_types')
          .where({ organization_id: req.auth.organizationId, id: req.params.id })
          .update({ ...toTypeColumns(body), updated_at: trx.fn.now() })
          .returning('*');
      } catch (err) {
        if (err.code === UNIQUE)
          throw conflict('CODE_TAKEN', 'A leave type with this code already exists');
        throw err;
      }
      if (!updated) throw notFound();
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'leave.type_updated',
        entityType: 'leave_type',
        entityId: updated.id,
        metadata: { values: body },
      });
      return updated;
    });
    res.json(presentType(row));
  });

  router.get('/settings', async (req, res) => {
    const s = await withTenant(db, req.auth.organizationId, (trx) =>
      leaveSettings(trx, req.auth.organizationId),
    );
    res.json({ leaveYearStartMonth: s.startMonth });
  });

  router.put('/settings', requirePermission(P.LEAVE_MANAGE), async (req, res) => {
    const body = validate(
      z.object({ leaveYearStartMonth: z.number().int().min(1).max(12) }).strict(),
      req.body,
    );
    await withTenant(db, req.auth.organizationId, async (trx) => {
      const used = await trx('leave_requests')
        .where({ organization_id: req.auth.organizationId })
        .first('id');
      const current = await leaveSettings(trx, req.auth.organizationId);
      if (used && current.startMonth !== body.leaveYearStartMonth) {
        throw conflict(
          'LEAVE_YEAR_LOCKED',
          'The leave year cannot change after leave has been requested',
        );
      }
      await trx('organizations')
        .where({ id: req.auth.organizationId })
        .update({ leave_year_start_month: body.leaveYearStartMonth, updated_at: trx.fn.now() });
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'leave.settings_updated',
        entityType: 'organization',
        entityId: req.auth.organizationId,
        metadata: body,
      });
    });
    res.json(body);
  });

  /** Requests visible to HR (branch scope) or to a manager (direct reports). */
  router.get('/requests', async (req, res) => {
    const q = validate(
      z.object({
        status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'all']).default('pending'),
      }),
      req.query,
    );
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const query = requestQuery(trx, req.auth.organizationId)
        .orderBy('r.created_at', 'desc')
        .limit(300);
      if (q.status !== 'all') query.where('r.status', q.status);
      const hrRead =
        req.auth.permissions.has(P.LEAVE_READ) || req.auth.permissions.has(P.LEAVE_MANAGE);
      if (hrRead) {
        if (req.auth.branchIds !== null) {
          query.where((w) => {
            w.whereIn('e.branch_id', req.auth.branchIds);
            if (req.auth.employee) w.orWhere('e.reporting_manager_id', req.auth.employee.id);
          });
        }
      } else if (req.auth.employee) {
        query.where('e.reporting_manager_id', req.auth.employee.id);
      } else {
        throw forbidden();
      }
      const rows = await query;
      return rows.map((r) => ({
        ...presentRequest(r),
        canDecide: r.status === 'pending' && canDecide(req.auth, r),
      }));
    });
    res.json({ data: result });
  });

  const decide = (approve) => async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body = validate(
      z.object({
        comment: approve
          ? z.string().trim().max(500).optional()
          : z.string().trim().min(3, 'Give a reason for rejecting').max(500),
      }),
      req.body,
    );
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      const r = await requestQuery(trx, req.auth.organizationId)
        .where('r.id', req.params.id)
        .first();
      if (!r) throw notFound();
      if (!canDecide(req.auth, r)) throw notFound();
      await trx('leave_requests').where({ id: r.id }).forUpdate().first('id');
      if (r.status !== 'pending')
        throw conflict('ALREADY_DECIDED', 'This request has already been decided');
      if (approve) {
        await assertRangeNotPayrollLocked(
          trx,
          req.auth.organizationId,
          r.employee_id,
          r.start_date,
          r.end_date,
        );
      }

      let update;
      if (!approve) {
        update = {
          status: 'rejected',
          decided_by_user_id: req.auth.userId,
          decided_at: trx.fn.now(),
          decision_comment: body.comment,
        };
      } else {
        const hr = isHr(req.auth, r.branch_id);
        const needsSecondLevel = r.type_levels === 2 && r.approval_level === 1 && !hr;
        if (needsSecondLevel) {
          update = {
            approval_level: 2,
            level1_by_user_id: req.auth.userId,
            level1_at: trx.fn.now(),
          };
        } else {
          // Re-check the balance at final approval (another leave may have been approved meanwhile).
          const settings = await leaveSettings(trx, req.auth.organizationId);
          const employee = await employeeRow(trx, req.auth.organizationId, r.employee_id);
          const balances = await balancesFor(trx, {
            organizationId: req.auth.organizationId,
            employee,
            year: r.leave_year,
            settings,
            excludeRequestId: r.id,
          });
          const b = balances.find((x) => x.type.id === r.leave_type_id);
          if (b && b.available !== null && Number(r.days) > b.available) {
            throw new AppError(
              409,
              'INSUFFICIENT_BALANCE',
              `Only ${b.available} day(s) of ${r.type_name} are available now`,
            );
          }
          update = {
            status: 'approved',
            decided_by_user_id: req.auth.userId,
            decided_at: trx.fn.now(),
            decision_comment: body.comment ?? null,
            ...(r.approval_level === 1
              ? { level1_by_user_id: req.auth.userId, level1_at: trx.fn.now() }
              : {}),
          };
        }
      }
      await trx('leave_requests').where({ id: r.id }).update(update);
      await recordAudit(trx, {
        ...auditContext(req),
        action: !approve
          ? 'leave.rejected'
          : update.status === 'approved'
            ? 'leave.approved'
            : 'leave.approved_level1',
        entityType: 'leave_request',
        entityId: r.id,
        reason: body.comment ?? null,
        metadata: { employeeId: r.employee_id, days: Number(r.days) },
      });
      return requestQuery(trx, req.auth.organizationId).where('r.id', r.id).first();
    });
    res.json(presentRequest(row));
  };
  router.post('/requests/:id/approve', decide(true));
  router.post('/requests/:id/reject', decide(false));

  /** HR cancels any request (including approved, already-started leave) with a reason. */
  router.post('/requests/:id/cancel', requirePermission(P.LEAVE_MANAGE), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body = validate(z.object({ comment: z.string().trim().min(3).max(500) }), req.body);
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      const r = await requestQuery(trx, req.auth.organizationId)
        .where('r.id', req.params.id)
        .first();
      if (!r || !isHr(req.auth, r.branch_id)) throw notFound();
      if (!['pending', 'approved'].includes(r.status))
        throw conflict('NOT_CANCELLABLE', 'This request cannot be cancelled');
      if (r.status === 'approved') {
        await assertRangeNotPayrollLocked(
          trx,
          req.auth.organizationId,
          r.employee_id,
          r.start_date,
          r.end_date,
        );
      }
      await trx('leave_requests').where({ id: r.id }).update({
        status: 'cancelled',
        cancelled_by_user_id: req.auth.userId,
        decided_at: trx.fn.now(),
        decision_comment: body.comment,
      });
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'leave.cancelled_by_hr',
        entityType: 'leave_request',
        entityId: r.id,
        reason: body.comment,
      });
      return requestQuery(trx, req.auth.organizationId).where('r.id', r.id).first();
    });
    res.json(presentRequest(row));
  });

  router.get('/balances', requirePermission(P.LEAVE_READ), async (req, res) => {
    const q = validate(
      z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }),
      req.query,
    );
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const settings = await leaveSettings(trx, req.auth.organizationId);
      const year = q.year ?? leaveYearOf(todayIn(settings.timeZone), settings.startMonth);
      const query = trx('employees')
        .where({ organization_id: req.auth.organizationId })
        .whereIn('employment_status', ['active', 'on_notice'])
        .orderBy('full_name')
        .select(
          'id',
          'full_name',
          'employee_number',
          'branch_id',
          'joining_date',
          'weekly_off_days',
        );
      if (req.auth.branchIds !== null) query.whereIn('branch_id', req.auth.branchIds);
      const employees = await query;
      const data = [];
      for (const e of employees) {
        data.push({
          employee: { id: e.id, fullName: e.full_name, employeeNumber: e.employee_number },
          balances: await balancesFor(trx, {
            organizationId: req.auth.organizationId,
            employee: e,
            year,
            settings,
          }),
        });
      }
      return { year, range: leaveYearRange(year, settings.startMonth), data };
    });
    res.json(result);
  });

  router.post('/adjustments', requirePermission(P.LEAVE_MANAGE), async (req, res) => {
    const body = validate(
      z
        .object({
          employeeId: z.string().uuid(),
          leaveTypeId: z.string().uuid(),
          year: z.number().int().min(2000).max(2100),
          days: z
            .number()
            .min(-365)
            .max(365)
            .multipleOf(0.5)
            .refine((d) => d !== 0, 'Days cannot be zero'),
          kind: z.enum(['opening', 'adjustment']).default('adjustment'),
          reason: z.string().trim().min(3).max(300),
        })
        .strict(),
      req.body,
    );
    await withTenant(db, req.auth.organizationId, async (trx) => {
      const emp = await employeeRow(trx, req.auth.organizationId, body.employeeId);
      if (!emp || !inBranchScope(req.auth, emp.branch_id)) throw notFound('Employee not found');
      const type = await trx('leave_types')
        .where({ organization_id: req.auth.organizationId, id: body.leaveTypeId })
        .first('id');
      if (!type) throw notFound('Leave type not found');
      const [row] = await trx('leave_balance_adjustments')
        .insert({
          organization_id: req.auth.organizationId,
          employee_id: emp.id,
          leave_type_id: type.id,
          leave_year: body.year,
          days: body.days,
          kind: body.kind,
          reason: body.reason,
          created_by_user_id: req.auth.userId,
        })
        .returning('id');
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'leave.balance_adjusted',
        entityType: 'employee',
        entityId: emp.id,
        reason: body.reason,
        metadata: {
          adjustmentId: row.id,
          leaveTypeId: type.id,
          year: body.year,
          days: body.days,
          kind: body.kind,
        },
      });
    });
    res.status(201).json({ ok: true });
  });

  /** Moves unused balance (up to each type's carry-forward limit) from one leave year to the next. */
  router.post('/carry-forward', requirePermission(P.LEAVE_MANAGE), async (req, res) => {
    const body = validate(
      z.object({ fromYear: z.number().int().min(2000).max(2100) }).strict(),
      req.body,
    );
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const settings = await leaveSettings(trx, req.auth.organizationId);
      const types = await trx('leave_types')
        .where({ organization_id: req.auth.organizationId })
        .where('carry_forward_max', '>', 0);
      const employees = await trx('employees')
        .where({ organization_id: req.auth.organizationId })
        .whereIn('employment_status', ['active', 'on_notice'])
        .modify((q) => req.auth.branchIds !== null && q.whereIn('branch_id', req.auth.branchIds))
        .select('id', 'joining_date', 'branch_id', 'weekly_off_days');
      let created = 0;
      for (const e of employees) {
        const balances = await balancesFor(trx, {
          organizationId: req.auth.organizationId,
          employee: e,
          year: body.fromYear,
          settings,
        });
        for (const t of types) {
          const b = balances.find((x) => x.type.id === t.id);
          const carry = Math.min(Number(t.carry_forward_max), Math.max(0, b?.available ?? 0));
          if (carry <= 0) continue;
          const already = await trx('leave_balance_adjustments')
            .where({
              organization_id: req.auth.organizationId,
              employee_id: e.id,
              leave_type_id: t.id,
              leave_year: body.fromYear + 1,
              kind: 'carry_forward',
            })
            .first('id');
          if (already) continue; // carry forward runs once per year (also enforced by a unique index)
          await trx('leave_balance_adjustments').insert({
            organization_id: req.auth.organizationId,
            employee_id: e.id,
            leave_type_id: t.id,
            leave_year: body.fromYear + 1,
            days: carry,
            kind: 'carry_forward',
            reason: `Carried forward from ${body.fromYear}`,
            created_by_user_id: req.auth.userId,
          });
          created += 1;
        }
      }
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'leave.carried_forward',
        entityType: 'organization',
        entityId: req.auth.organizationId,
        metadata: { fromYear: body.fromYear, entries: created },
      });
      return { fromYear: body.fromYear, toYear: body.fromYear + 1, entries: created };
    });
    res.json(result);
  });

  /** Leave calendar for a month: approved and pending leave in scope. */
  router.get('/calendar', async (req, res) => {
    const q = validate(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }), req.query);
    const rows = await withTenant(db, req.auth.organizationId, async (trx) => {
      const query = requestQuery(trx, req.auth.organizationId)
        .whereIn('r.status', ['approved', 'pending'])
        .where('r.start_date', '<=', monthEnd(q.month))
        .where('r.end_date', '>=', `${q.month}-01`)
        .orderBy('r.start_date');
      if (req.auth.permissions.has(P.LEAVE_READ)) {
        if (req.auth.branchIds !== null) query.whereIn('e.branch_id', req.auth.branchIds);
      } else if (req.auth.employee) {
        query.where((w) =>
          w
            .where('e.reporting_manager_id', req.auth.employee.id)
            .orWhere('e.id', req.auth.employee.id),
        );
      } else {
        throw forbidden();
      }
      return query;
    });
    res.json({ month: q.month, data: rows.map(presentRequest) });
  });

  router.get('/export', requirePermission(P.LEAVE_READ), async (req, res) => {
    const q = validate(z.object({ year: z.coerce.number().int().min(2000).max(2100) }), req.query);
    const rows = await withTenant(db, req.auth.organizationId, (trx) =>
      requestQuery(trx, req.auth.organizationId)
        .where('r.leave_year', q.year)
        .where('r.status', 'approved')
        .modify(
          (qb) => req.auth.branchIds !== null && qb.whereIn('e.branch_id', req.auth.branchIds),
        )
        .orderBy(['e.full_name', 'r.start_date']),
    );
    const cell = (v) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      ['Employee ID', 'Name', 'Leave type', 'Paid', 'From', 'To', 'Days', 'Reason', 'Approved by'],
      ...rows.map((r) => [
        r.employee_number,
        r.employee_name,
        r.type_name,
        r.type_is_paid ? 'Yes' : 'No',
        r.start_date,
        r.end_date,
        Number(r.days),
        r.reason,
        r.decider_name ?? '',
      ]),
    ];
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="approved-leave-${q.year}.csv"`);
    res.send(`\uFEFF${lines.map((l) => l.map(cell).join(',')).join('\r\n')}\r\n`);
  });

  return router;
}
