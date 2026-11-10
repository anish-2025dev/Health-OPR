import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { isUuid, withTenant } from '../../core/db.js';
import { AppError, conflict, forbidden, notFound } from '../../core/errors.js';
import { maskMobile } from '../../core/phone.js';
import { auditContext, recordAudit } from '../audit/index.js';
import { PERMISSIONS, requirePermission } from '../staff-access/permissions.js';
import { checkGeofence, monthEnd } from './calc.js';
import {
  applyCorrection,
  buildMonth,
  buildRegister,
  getPolicy,
  loadEmployee,
  nextAction,
  presentDay,
  presentPolicy,
  recordPunch,
  summarizeRegister,
  todayFor,
} from './service.js';

const P = PERMISSIONS;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');
const SIGN_IN_STATUSES = ['active', 'on_notice'];
const EDITABLE_STATUSES = ['present', 'half_day', 'reduced_hours', 'absent', 'week_off', 'holiday'];

const GEOFENCE_MESSAGES = {
  BRANCH_LOCATION_NOT_SET:
    "Your branch's attendance location hasn't been set yet. Ask your administrator to set it.",
  LOCATION_TOO_IMPRECISE:
    'Your location is not precise enough to confirm. Turn on precise location, move near a window, and try again.',
  OUTSIDE_GEOFENCE: 'You are not at your branch. Attendance can only be marked at the clinic.',
};

const currentMonth = (tz) => todayFor(tz).slice(0, 7);

// ------------------------------------------------------------------ CSV

/** CSV cell with formula-injection protection (=, +, -, @ prefixed with '). */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const hours = (mins) =>
  mins ? `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}` : '';

function sendCsv(res, filename, rows) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  // UTF-8 byte-order mark so Excel opens names in Indian scripts correctly.
  res.send(`\uFEFF${csv(rows)}`);
}

// ------------------------------------------------------------------ access helpers

const requireEmployee = (req, res, next) => {
  if (!req.auth.employee) {
    return next(
      new AppError(403, 'NO_EMPLOYEE_PROFILE', 'Your login is not linked to an employee profile'),
    );
  }
  next();
};

const inBranchScope = (auth, emp) =>
  auth.branchIds === null || auth.branchIds.includes(emp.branch.id);
const isManagerOf = (auth, emp) =>
  Boolean(auth.employee) && emp.reportingManagerId === auth.employee.id;

function canView(auth, emp) {
  if (auth.employee?.id === emp.id) return true;
  if (auth.permissions.has(P.ATTENDANCE_READ) && inBranchScope(auth, emp)) return true;
  return isManagerOf(auth, emp);
}

const canManage = (auth, emp) =>
  auth.permissions.has(P.ATTENDANCE_MANAGE) && inBranchScope(auth, emp);
const canDecide = (auth, emp) =>
  auth.employee?.id !== emp.id && (canManage(auth, emp) || isManagerOf(auth, emp));

// ------------------------------------------------------------------ schemas

const startSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().positive().max(100_000),
  })
  .strict();
const confirmSchema = z
  .object({
    challengeId: z.string().uuid(),
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'Enter the 6-digit code'),
  })
  .strict();
const monthQuery = z.object({ month: MONTH.optional() });

const regularizationSchema = z
  .object({
    date: DATE,
    checkIn: TIME.optional(),
    checkOut: TIME.optional(),
    status: z.enum(EDITABLE_STATUSES).optional(),
    reason: z.string().trim().min(5, 'Explain in at least 5 characters').max(500),
  })
  .strict()
  .refine((v) => v.checkIn || v.checkOut || v.status, {
    message: 'Give a corrected check-in, check-out or status',
  });

const manualEditSchema = z
  .object({
    status: z.enum(EDITABLE_STATUSES).optional(),
    checkIn: TIME.optional(),
    checkOut: TIME.optional(),
    reason: z.string().trim().min(5, 'A reason of at least 5 characters is required').max(500),
  })
  .strict()
  .refine((v) => v.status || v.checkIn || v.checkOut, { message: 'Change the status or a time' });

const policySchema = z
  .object({
    fullDayMinutes: z.number().int().min(60).max(1440),
    halfDayMinutes: z.number().int().min(30).max(1440),
    belowHalfDayStatus: z.enum(['absent', 'reduced_hours']),
    lateGraceMinutes: z.number().int().min(0).max(240),
    lateFreePerMonth: z.number().int().min(0).max(31),
    latePenaltyMode: z.enum(['none', 'fixed_amount', 'half_day_per_n', 'full_day_per_n']),
    latePenaltyAmount: z
      .string()
      .regex(/^\d{1,10}(\.\d{1,2})?$/, 'Amount like 50 or 50.00')
      .nullable()
      .optional(),
    latePenaltyEveryN: z.number().int().min(1).max(31).nullable().optional(),
    overtimeAfterMinutes: z.number().int().min(0).max(600),
    minPunchGapSeconds: z.number().int().min(0).max(3600),
  })
  .strict()
  .refine((v) => v.halfDayMinutes <= v.fullDayMinutes, {
    path: ['halfDayMinutes'],
    message: 'Half-day hours cannot exceed full-day hours',
  })
  .refine((v) => v.latePenaltyMode !== 'fixed_amount' || v.latePenaltyAmount, {
    path: ['latePenaltyAmount'],
    message: 'Enter the penalty amount',
  })
  .refine(
    (v) => !['half_day_per_n', 'full_day_per_n'].includes(v.latePenaltyMode) || v.latePenaltyEveryN,
    {
      path: ['latePenaltyEveryN'],
      message: 'Enter how many late arrivals count as one deduction',
    },
  );

const presentRegularization = (r) => ({
  id: r.id,
  employee: r.employee_name
    ? { id: r.employee_id, fullName: r.employee_name, employeeNumber: r.employee_number }
    : { id: r.employee_id },
  date: r.work_date,
  checkIn: r.requested_in ? String(r.requested_in).slice(0, 5) : null,
  checkOut: r.requested_out ? String(r.requested_out).slice(0, 5) : null,
  status: r.requested_status,
  reason: r.reason,
  state: r.status,
  decidedBy: r.decider_name ?? null,
  decidedAt: r.decided_at,
  decisionComment: r.decision_comment,
  createdAt: r.created_at,
});

// ================================================================== employee self-service (/me)

export function selfAttendanceRouter({ db, otp }) {
  const router = Router();
  router.use(requireEmployee);

  const loadSelf = async (trx, req) => {
    const emp = await loadEmployee(trx, req.auth.organizationId, req.auth.employee.id);
    if (!emp || !SIGN_IN_STATUSES.includes(emp.status)) {
      throw new AppError(403, 'EMPLOYEE_INACTIVE', 'Your employee profile is not active');
    }
    return emp;
  };

  router.get('/attendance/today', async (req, res) => {
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const emp = await loadSelf(trx, req);
      const { action, workDate, day } = await nextAction(trx, req.auth.organizationId, emp);
      return {
        employee: { id: emp.id, employeeNumber: emp.employeeNumber, fullName: emp.fullName },
        branch: {
          name: emp.branch.name,
          locationConfigured: Boolean(emp.branch.location),
          radiusM: emp.branch.geofenceRadiusM,
        },
        shift: emp.shift,
        nextAction: action,
        workDate,
        today: day ? presentDay(day, emp.branch.timeZone) : null,
        smsAvailable: otp.smsProvider !== 'none',
      };
    });
    res.json(result);
  });

  /** Step 1: verify location; only then send an OTP. */
  router.post('/attendance/start', async (req, res) => {
    const body = validate(startSchema, req.body);
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const emp = await loadSelf(trx, req);
      const geo = checkGeofence({ branch: emp.branch, position: body });
      if (!geo.ok) return { rejected: geo, emp };
      const { action } = await nextAction(trx, req.auth.organizationId, emp);
      const challenge = await otp.issue(trx, {
        organizationId: req.auth.organizationId,
        employeeId: emp.id,
        purpose: 'attendance',
        mobile: emp.mobile,
        metadata: {
          branchId: emp.branch.id,
          distanceM: geo.distanceM,
          accuracyM: geo.accuracyM,
          action,
        },
        ip: req.ip ?? null,
      });
      return { challenge, action, emp, geo };
    });

    if (result.rejected) {
      // Record the failed attempt (committed separately; nothing is marked).
      await withTenant(db, req.auth.organizationId, (trx) =>
        recordAudit(trx, {
          ...auditContext(req),
          action: 'attendance.attempt_rejected',
          entityType: 'employee',
          entityId: result.emp.id,
          reason: result.rejected.reason,
          metadata: {
            distanceM: result.rejected.distanceM ?? null,
            accuracyM: result.rejected.accuracyM ?? null,
            radiusM: result.rejected.radiusM,
          },
        }),
      );
      throw new AppError(422, result.rejected.reason, GEOFENCE_MESSAGES[result.rejected.reason], {
        distanceM: result.rejected.distanceM ?? null,
        accuracyM: result.rejected.accuracyM ?? null,
        radiusM: result.rejected.radiusM,
      });
    }

    res.status(201).json({
      challengeId: result.challenge.challengeId,
      expiresInSeconds: result.challenge.expiresInSeconds,
      sentTo: maskMobile(result.emp.mobile),
      action: result.action,
      distanceM: result.geo.distanceM,
    });
  });

  /** Step 2: confirm with the OTP; the punch is recorded in the same transaction as consuming the code. */
  router.post('/attendance/confirm', async (req, res) => {
    const body = validate(confirmSchema, req.body);
    const result = await otp.verify(
      {
        organizationId: req.auth.organizationId,
        employeeId: req.auth.employee.id,
        purpose: 'attendance',
        challengeId: body.challengeId,
        code: body.code,
      },
      async (trx, challenge) => {
        const emp = await loadSelf(trx, req);
        const policy = await getPolicy(trx, req.auth.organizationId);
        const { punch, day } = await recordPunch(trx, {
          organizationId: req.auth.organizationId,
          emp,
          policy,
          at: new Date(),
          source: 'app_otp_geo',
          distanceM: challenge.metadata.distanceM,
          accuracyM: challenge.metadata.accuracyM,
          challengeId: challenge.id,
          userId: req.auth.userId,
        });
        await recordAudit(trx, {
          ...auditContext(req),
          action: punch.punch_type === 'in' ? 'attendance.check_in' : 'attendance.check_out',
          entityType: 'employee',
          entityId: emp.id,
          metadata: { workDate: day.work_date, distanceM: challenge.metadata.distanceM },
        });
        return { punchType: punch.punch_type, emp, day };
      },
    );
    res.status(201).json({
      punchType: result.punchType,
      day: presentDay(result.day, result.emp.branch.timeZone),
    });
  });

  router.get('/attendance', async (req, res) => {
    const q = validate(monthQuery, req.query);
    const data = await withTenant(db, req.auth.organizationId, async (trx) => {
      const emp = await loadEmployee(trx, req.auth.organizationId, req.auth.employee.id);
      const policy = await getPolicy(trx, req.auth.organizationId);
      return buildMonth(trx, {
        organizationId: req.auth.organizationId,
        emp,
        policy,
        month: q.month ?? currentMonth(emp.branch.timeZone),
      });
    });
    res.json(data);
  });

  router.get('/attendance/regularizations', async (req, res) => {
    const rows = await withTenant(db, req.auth.organizationId, (trx) =>
      trx('attendance_regularizations as r')
        .leftJoin('users as u', 'u.id', 'r.decided_by_user_id')
        .where({
          'r.organization_id': req.auth.organizationId,
          'r.employee_id': req.auth.employee.id,
        })
        .select('r.*', 'u.full_name as decider_name')
        .orderBy('r.created_at', 'desc')
        .limit(100),
    );
    res.json({ data: rows.map(presentRegularization) });
  });

  router.post('/attendance/regularizations', async (req, res) => {
    const body = validate(regularizationSchema, req.body);
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      const emp = await loadSelf(trx, req);
      const today = todayFor(emp.branch.timeZone);
      if (body.date > today)
        throw new AppError(400, 'VALIDATION_ERROR', 'You cannot correct a future date');
      if (body.date < emp.joiningDate)
        throw new AppError(400, 'VALIDATION_ERROR', 'Date is before your joining date');
      const day = await trx('attendance_days')
        .where({
          organization_id: req.auth.organizationId,
          employee_id: emp.id,
          work_date: body.date,
        })
        .first('locked_at');
      if (day?.locked_at)
        throw new AppError(
          409,
          'DAY_LOCKED',
          'This day is locked because payroll has been finalized',
        );
      let created;
      try {
        [created] = await trx('attendance_regularizations')
          .insert({
            organization_id: req.auth.organizationId,
            employee_id: emp.id,
            work_date: body.date,
            requested_in: body.checkIn ?? null,
            requested_out: body.checkOut ?? null,
            requested_status: body.status ?? null,
            reason: body.reason,
          })
          .returning('*');
      } catch (err) {
        if (err.code === '23505')
          throw conflict('REQUEST_PENDING', 'You already have a pending request for this date');
        throw err;
      }
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'attendance.regularization_requested',
        entityType: 'attendance_regularization',
        entityId: created.id,
        metadata: { date: body.date },
      });
      return created;
    });
    res.status(201).json(presentRegularization(row));
  });

  router.post('/attendance/regularizations/:id/cancel', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      const [updated] = await trx('attendance_regularizations')
        .where({
          organization_id: req.auth.organizationId,
          id: req.params.id,
          employee_id: req.auth.employee.id,
          status: 'pending',
        })
        .update({ status: 'cancelled', decided_at: trx.fn.now() })
        .returning('*');
      if (!updated) throw notFound('No pending request found');
      return updated;
    });
    res.json(presentRegularization(row));
  });

  return router;
}

// ================================================================== admin / manager (/attendance)

export function attendanceRouter({ db }) {
  const router = Router();

  router.get('/policy', requirePermission(P.ATTENDANCE_READ), async (req, res) => {
    const policy = await withTenant(db, req.auth.organizationId, (trx) =>
      getPolicy(trx, req.auth.organizationId),
    );
    res.json(presentPolicy(policy));
  });

  router.put('/policy', requirePermission(P.ATTENDANCE_MANAGE), async (req, res) => {
    const body = validate(policySchema, req.body);
    const policy = await withTenant(db, req.auth.organizationId, async (trx) => {
      await getPolicy(trx, req.auth.organizationId);
      const [updated] = await trx('attendance_policies')
        .where({ organization_id: req.auth.organizationId })
        .update({
          full_day_minutes: body.fullDayMinutes,
          half_day_minutes: body.halfDayMinutes,
          below_half_day_status: body.belowHalfDayStatus,
          late_grace_minutes: body.lateGraceMinutes,
          late_free_per_month: body.lateFreePerMonth,
          late_penalty_mode: body.latePenaltyMode,
          late_penalty_amount:
            body.latePenaltyMode === 'fixed_amount' ? body.latePenaltyAmount : null,
          late_penalty_every_n: ['half_day_per_n', 'full_day_per_n'].includes(body.latePenaltyMode)
            ? body.latePenaltyEveryN
            : null,
          overtime_after_minutes: body.overtimeAfterMinutes,
          min_punch_gap_seconds: body.minPunchGapSeconds,
          updated_by_user_id: req.auth.userId,
          updated_at: trx.fn.now(),
        })
        .returning('*');
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'attendance.policy_updated',
        entityType: 'attendance_policy',
        entityId: updated.id,
        metadata: { values: body },
      });
      return updated;
    });
    res.json(presentPolicy(policy));
  });

  router.get('/dashboard', requirePermission(P.ATTENDANCE_READ), async (req, res) => {
    const q = validate(z.object({ date: DATE.optional() }), req.query);
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const org = await trx('organizations')
        .where({ id: req.auth.organizationId })
        .first('timezone');
      const date = q.date ?? todayFor(org.timezone);
      const entries = await buildRegister(trx, { auth: req.auth, date });
      const { totals, byDepartment } = summarizeRegister(entries);
      const lateToday = entries
        .filter((e) => e.day.isLate)
        .map((e) => ({
          employee: e.employee,
          checkIn: e.day.checkIn,
          lateMinutes: e.day.lateMinutes,
          category: e.day.lateMinutes > 60 ? 'Very late' : 'Late',
        }))
        .sort((a, b) => b.lateMinutes - a.lateMinutes);
      const month = date.slice(0, 7);
      const holidays = await trx('holidays')
        .where({ organization_id: req.auth.organizationId })
        .whereBetween('holiday_date', [`${month}-01`, monthEnd(month)])
        .orderBy('holiday_date')
        .select('holiday_date as date', 'name', 'branch_id as branchId');
      return { date, totals, byDepartment, lateToday, holidays };
    });
    res.json(result);
  });

  router.get('/register', requirePermission(P.ATTENDANCE_READ), async (req, res) => {
    const q = validate(
      z.object({
        date: DATE.optional(),
        branchId: z.string().uuid().optional(),
        departmentId: z.string().uuid().optional(),
      }),
      req.query,
    );
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const org = await trx('organizations')
        .where({ id: req.auth.organizationId })
        .first('timezone');
      const date = q.date ?? todayFor(org.timezone);
      const entries = await buildRegister(trx, {
        auth: req.auth,
        date,
        branchId: q.branchId,
        departmentId: q.departmentId,
      });
      return { date, data: entries, ...summarizeRegister(entries) };
    });
    res.json(result);
  });

  /** Direct reports of the signed-in manager, with this month's summary. */
  router.get('/team', requireEmployee, async (req, res) => {
    const q = validate(monthQuery, req.query);
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const ids = await trx('employees')
        .where({
          organization_id: req.auth.organizationId,
          reporting_manager_id: req.auth.employee.id,
        })
        .whereIn('employment_status', SIGN_IN_STATUSES)
        .orderBy('full_name')
        .pluck('id');
      const policy = await getPolicy(trx, req.auth.organizationId);
      const data = [];
      for (const id of ids) {
        const emp = await loadEmployee(trx, req.auth.organizationId, id);
        const month = await buildMonth(trx, {
          organizationId: req.auth.organizationId,
          emp,
          policy,
          month: q.month ?? currentMonth(emp.branch.timeZone),
        });
        data.push({ employee: month.employee, summary: month.summary, month: month.month });
      }
      return { data };
    });
    res.json(result);
  });

  router.get('/employees/:id/month', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Employee not found');
    const q = validate(monthQuery, req.query);
    const data = await withTenant(db, req.auth.organizationId, async (trx) => {
      const emp = await loadEmployee(trx, req.auth.organizationId, req.params.id);
      if (!emp || !canView(req.auth, emp)) throw notFound('Employee not found');
      const policy = await getPolicy(trx, req.auth.organizationId);
      const month = await buildMonth(trx, {
        organizationId: req.auth.organizationId,
        emp,
        policy,
        month: q.month ?? currentMonth(emp.branch.timeZone),
      });
      return { ...month, canEdit: canManage(req.auth, emp) };
    });
    res.json(data);
  });

  /** Manual correction by HR: mandatory reason, audit-logged, punches voided (not deleted). */
  router.put(
    '/employees/:id/days/:date',
    requirePermission(P.ATTENDANCE_MANAGE),
    async (req, res) => {
      if (!isUuid(req.params.id)) throw notFound('Employee not found');
      const date = validate(DATE, req.params.date);
      const body = validate(manualEditSchema, req.body);
      const result = await withTenant(db, req.auth.organizationId, async (trx) => {
        const emp = await loadEmployee(trx, req.auth.organizationId, req.params.id);
        if (!emp || !canManage(req.auth, emp)) throw notFound('Employee not found');
        if (emp.joiningDate > date)
          throw new AppError(400, 'VALIDATION_ERROR', 'Date is before the joining date');
        if (date > todayFor(emp.branch.timeZone)) {
          throw new AppError(400, 'VALIDATION_ERROR', 'You cannot edit a future date');
        }
        const policy = await getPolicy(trx, req.auth.organizationId);
        const day = await applyCorrection(trx, {
          organizationId: req.auth.organizationId,
          emp,
          policy,
          workDate: date,
          status: body.status,
          checkIn: body.checkIn,
          checkOut: body.checkOut,
          reason: body.reason,
          userId: req.auth.userId,
          source: 'manual',
        });
        await recordAudit(trx, {
          ...auditContext(req),
          action: 'attendance.day_edited',
          entityType: 'employee',
          entityId: emp.id,
          reason: body.reason,
          metadata: {
            date,
            status: body.status ?? null,
            checkIn: body.checkIn ?? null,
            checkOut: body.checkOut ?? null,
          },
        });
        return presentDay(day, emp.branch.timeZone);
      });
      res.json(result);
    },
  );

  router.get('/regularizations', async (req, res) => {
    const q = validate(
      z.object({
        status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'all']).default('pending'),
      }),
      req.query,
    );
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const query = trx('attendance_regularizations as r')
        .join('employees as e', 'e.id', 'r.employee_id')
        .leftJoin('users as u', 'u.id', 'r.decided_by_user_id')
        .where('r.organization_id', req.auth.organizationId)
        .select(
          'r.*',
          'e.full_name as employee_name',
          'e.employee_number',
          'e.branch_id',
          'u.full_name as decider_name',
        )
        .orderBy('r.created_at', 'desc')
        .limit(200);
      if (q.status !== 'all') query.where('r.status', q.status);
      const canManageAll = req.auth.permissions.has(P.ATTENDANCE_MANAGE);
      if (canManageAll && req.auth.branchIds !== null) {
        query.where((w) => {
          w.whereIn('e.branch_id', req.auth.branchIds);
          if (req.auth.employee) w.orWhere('e.reporting_manager_id', req.auth.employee.id);
        });
      } else if (!canManageAll) {
        if (!req.auth.employee) throw forbidden();
        query.where('e.reporting_manager_id', req.auth.employee.id);
      }
      const rows = await query;
      const counts = await trx('attendance_regularizations as r')
        .join('employees as e', 'e.id', 'r.employee_id')
        .where('r.organization_id', req.auth.organizationId)
        .modify((qb) => {
          if (!canManageAll) qb.where('e.reporting_manager_id', req.auth.employee.id);
          else if (req.auth.branchIds !== null) qb.whereIn('e.branch_id', req.auth.branchIds);
        })
        .groupBy('r.status')
        .select('r.status')
        .count({ n: '*' });
      return {
        data: rows.map(presentRegularization),
        counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      };
    });
    res.json(result);
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
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const reg = await trx('attendance_regularizations')
        .where({ organization_id: req.auth.organizationId, id: req.params.id })
        .forUpdate()
        .first();
      if (!reg) throw notFound();
      const emp = await loadEmployee(trx, req.auth.organizationId, reg.employee_id);
      if (!canDecide(req.auth, emp)) throw notFound();
      if (reg.status !== 'pending')
        throw conflict('ALREADY_DECIDED', 'This request has already been decided');

      if (approve) {
        const policy = await getPolicy(trx, req.auth.organizationId);
        await applyCorrection(trx, {
          organizationId: req.auth.organizationId,
          emp,
          policy,
          workDate: reg.work_date,
          status: reg.requested_status ?? undefined,
          checkIn: reg.requested_in ? String(reg.requested_in).slice(0, 5) : undefined,
          checkOut: reg.requested_out ? String(reg.requested_out).slice(0, 5) : undefined,
          reason: `Regularization: ${reg.reason}`,
          userId: req.auth.userId,
          source: 'regularization',
        });
      }
      const [updated] = await trx('attendance_regularizations')
        .where({ id: reg.id })
        .update({
          status: approve ? 'approved' : 'rejected',
          decided_by_user_id: req.auth.userId,
          decided_at: trx.fn.now(),
          decision_comment: body.comment ?? null,
        })
        .returning('*');
      await recordAudit(trx, {
        ...auditContext(req),
        action: approve
          ? 'attendance.regularization_approved'
          : 'attendance.regularization_rejected',
        entityType: 'attendance_regularization',
        entityId: reg.id,
        reason: body.comment ?? null,
        metadata: { employeeId: emp.id, date: reg.work_date },
      });
      return updated;
    });
    res.json(presentRegularization(result));
  };
  router.post('/regularizations/:id/approve', decide(true));
  router.post('/regularizations/:id/reject', decide(false));

  /** Daily attendance rows for every employee in scope for a month (CSV). */
  router.get('/export', requirePermission(P.ATTENDANCE_READ), async (req, res) => {
    const q = validate(
      z.object({ month: MONTH, branchId: z.string().uuid().optional() }),
      req.query,
    );
    const rows = await withTenant(db, req.auth.organizationId, async (trx) => {
      const query = trx('employees')
        .where({ organization_id: req.auth.organizationId })
        .where('joining_date', '<=', monthEnd(q.month))
        .orderBy('full_name')
        .pluck('id');
      if (req.auth.branchIds !== null) query.whereIn('branch_id', req.auth.branchIds);
      if (q.branchId) query.where('branch_id', q.branchId);
      const ids = await query;
      const policy = await getPolicy(trx, req.auth.organizationId);
      const out = [
        [
          'Employee ID',
          'Name',
          'Department',
          'Branch',
          'Date',
          'Status',
          'Check in',
          'Check out',
          'Worked (h:mm)',
          'Late (min)',
          'Overtime (h:mm)',
          'Source',
          'Note',
        ],
      ];
      for (const id of ids) {
        const emp = await loadEmployee(trx, req.auth.organizationId, id);
        const month = await buildMonth(trx, {
          organizationId: req.auth.organizationId,
          emp,
          policy,
          month: q.month,
        });
        for (const d of month.days) {
          if (d.status === 'not_employed' || d.status === 'upcoming') continue;
          out.push([
            emp.employeeNumber,
            emp.fullName,
            emp.departmentName ?? '',
            emp.branch.name,
            d.date,
            d.status,
            d.checkIn ?? '',
            d.checkOut ?? '',
            hours(d.workedMinutes),
            d.isLate ? d.lateMinutes : '',
            hours(d.overtimeMinutes),
            d.statusSource,
            d.holidayName ?? d.manualReason ?? '',
          ]);
        }
      }
      return out;
    });
    sendCsv(res, `attendance-${q.month}.csv`, rows);
  });

  router.get('/holidays/export', requirePermission(P.HOLIDAYS_READ), async (req, res) => {
    const q = validate(z.object({ year: z.coerce.number().int().min(2000).max(2100) }), req.query);
    const rows = await withTenant(db, req.auth.organizationId, (trx) =>
      trx('holidays as h')
        .leftJoin('branches as b', 'b.id', 'h.branch_id')
        .where('h.organization_id', req.auth.organizationId)
        .whereBetween('h.holiday_date', [`${q.year}-01-01`, `${q.year}-12-31`])
        .orderBy('h.holiday_date')
        .select('h.holiday_date', 'h.name', 'h.is_optional', 'b.name as branch_name'),
    );
    sendCsv(res, `holidays-${q.year}.csv`, [
      ['Date', 'Holiday', 'Applies to', 'Optional'],
      ...rows.map((h) => [
        h.holiday_date,
        h.name,
        h.branch_name ?? 'All branches',
        h.is_optional ? 'Yes' : 'No',
      ]),
    ]);
  });

  return router;
}
