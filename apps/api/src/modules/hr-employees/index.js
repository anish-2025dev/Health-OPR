import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { isUuid, withTenant } from '../../core/db.js';
import { AppError, conflict, notFound } from '../../core/errors.js';
import { maskMobile, mobileSchema } from '../../core/phone.js';
import { auditContext, recordAudit } from '../audit/index.js';
import { PERMISSIONS, requirePermission } from '../staff-access/permissions.js';

const P = PERMISSIONS;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const uuidOrNull = z.string().uuid().nullable();
const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern', 'consultant'];
const EMPLOYMENT_STATUSES = ['active', 'on_notice', 'suspended', 'exited'];

const baseFields = {
  fullName: z.string().trim().min(2).max(200),
  mobile: mobileSchema,
  email: z.string().trim().toLowerCase().email().max(254).nullable(),
  branchId: z.string().uuid(),
  departmentId: uuidOrNull,
  designationId: uuidOrNull,
  reportingManagerId: uuidOrNull,
  shiftId: uuidOrNull,
  userId: uuidOrNull,
  weeklyOffDays: z
    .array(z.number().int().min(0).max(6))
    .max(7)
    .transform((days) => [...new Set(days)].sort()),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  joiningDate: DATE,
  emergencyContactName: z.string().trim().max(200).nullable(),
  emergencyContactPhone: mobileSchema.nullable(),
};

const createSchema = z
  .object({
    ...baseFields,
    employeeNumber: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,20}$/, 'Use up to 20 letters, digits or dashes')
      .optional(),
    email: baseFields.email.optional(),
    departmentId: uuidOrNull.optional(),
    designationId: uuidOrNull.optional(),
    reportingManagerId: uuidOrNull.optional(),
    shiftId: uuidOrNull.optional(),
    userId: uuidOrNull.optional(),
    weeklyOffDays: baseFields.weeklyOffDays.default([0]),
    employmentType: baseFields.employmentType.default('full_time'),
    emergencyContactName: baseFields.emergencyContactName.optional(),
    emergencyContactPhone: baseFields.emergencyContactPhone.optional(),
  })
  .strict();

const updateSchema = z
  .object({
    ...Object.fromEntries(Object.entries(baseFields).map(([k, v]) => [k, v.optional()])),
    employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional(),
    exitDate: DATE.nullable().optional(),
  })
  .strict();

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  branchId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  status: z.enum([...EMPLOYMENT_STATUSES, 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const COLUMN_MAP = {
  fullName: 'full_name',
  mobile: 'mobile_e164',
  email: 'email',
  branchId: 'branch_id',
  departmentId: 'department_id',
  designationId: 'designation_id',
  reportingManagerId: 'reporting_manager_id',
  shiftId: 'shift_id',
  userId: 'user_id',
  weeklyOffDays: 'weekly_off_days',
  employmentType: 'employment_type',
  joiningDate: 'joining_date',
  emergencyContactName: 'emergency_contact_name',
  emergencyContactPhone: 'emergency_contact_phone',
  employmentStatus: 'employment_status',
  exitDate: 'exit_date',
};

const toColumns = (body) =>
  Object.fromEntries(
    Object.entries(body)
      .filter(([k]) => COLUMN_MAP[k])
      .map(([k, v]) => [COLUMN_MAP[k], v]),
  );

function baseQuery(trx, organizationId) {
  return trx('employees as e')
    .leftJoin('branches as b', 'b.id', 'e.branch_id')
    .leftJoin('departments as d', 'd.id', 'e.department_id')
    .leftJoin('designations as g', 'g.id', 'e.designation_id')
    .leftJoin('shifts as s', 's.id', 'e.shift_id')
    .leftJoin('employees as m', 'm.id', 'e.reporting_manager_id')
    .where('e.organization_id', organizationId)
    .select(
      'e.*',
      'b.name as branch_name',
      'd.name as department_name',
      'g.name as designation_name',
      's.name as shift_name',
      'm.full_name as manager_name',
      'm.employee_number as manager_number',
    );
}

/** Branch scope: null = all branches. */
const scoped = (query, auth) =>
  auth.branchIds === null ? query : query.whereIn('e.branch_id', auth.branchIds);

/** Users without employees.manage see masked contact details and no emergency contact. */
function present(e, auth) {
  const full = auth.permissions.has(P.EMPLOYEES_MANAGE);
  return {
    id: e.id,
    employeeNumber: e.employee_number,
    fullName: e.full_name,
    mobile: full ? e.mobile_e164 : maskMobile(e.mobile_e164),
    email: e.email,
    branch: { id: e.branch_id, name: e.branch_name },
    department: e.department_id ? { id: e.department_id, name: e.department_name } : null,
    designation: e.designation_id ? { id: e.designation_id, name: e.designation_name } : null,
    shift: e.shift_id ? { id: e.shift_id, name: e.shift_name } : null,
    reportingManager: e.reporting_manager_id
      ? { id: e.reporting_manager_id, name: e.manager_name, employeeNumber: e.manager_number }
      : null,
    userId: e.user_id,
    weeklyOffDays: e.weekly_off_days,
    employmentType: e.employment_type,
    employmentStatus: e.employment_status,
    joiningDate: e.joining_date,
    exitDate: e.exit_date,
    emergencyContact: full
      ? { name: e.emergency_contact_name, phone: e.emergency_contact_phone }
      : undefined,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  };
}

const badRef = (what) => new AppError(400, 'VALIDATION_ERROR', `Unknown or inactive ${what}`);

/** Checks every referenced record exists in this organization (and is usable). */
async function assertReferences(trx, auth, values, employeeId = null) {
  const org = auth.organizationId;
  if (values.branch_id) {
    const inScope = auth.branchIds === null || auth.branchIds.includes(values.branch_id);
    const branch = await trx('branches')
      .where({ organization_id: org, id: values.branch_id })
      .first('status');
    if (!branch || !inScope) throw badRef('branch');
  }
  for (const [column, table, label] of [
    ['department_id', 'departments', 'department'],
    ['designation_id', 'designations', 'designation'],
    ['shift_id', 'shifts', 'shift'],
  ]) {
    if (values[column]) {
      const row = await trx(table)
        .where({ organization_id: org, id: values[column] })
        .first('status');
      if (!row || row.status !== 'active') throw badRef(label);
    }
  }
  if (values.user_id) {
    const user = await trx('users').where({ organization_id: org, id: values.user_id }).first('id');
    if (!user) throw badRef('user account');
  }
  if (values.reporting_manager_id) {
    if (values.reporting_manager_id === employeeId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'An employee cannot report to themselves');
    }
    const manager = await trx('employees')
      .where({ organization_id: org, id: values.reporting_manager_id })
      .first('employment_status');
    if (!manager || manager.employment_status === 'exited') throw badRef('reporting manager');
    if (employeeId) {
      // Reject cycles: walk up the proposed manager's chain looking for this employee.
      const { rows } = await trx.raw(
        `WITH RECURSIVE chain AS (
           SELECT id, reporting_manager_id, 1 AS depth FROM employees
            WHERE organization_id = ? AND id = ?
           UNION ALL
           SELECT e.id, e.reporting_manager_id, c.depth + 1 FROM employees e
             JOIN chain c ON e.id = c.reporting_manager_id
            WHERE e.organization_id = ? AND c.depth < 50
         )
         SELECT 1 FROM chain WHERE id = ? LIMIT 1`,
        [org, values.reporting_manager_id, org, employeeId],
      );
      if (rows.length) {
        throw new AppError(
          400,
          'REPORTING_CYCLE',
          'This reporting manager would create a reporting loop',
        );
      }
    }
  }
}

function translateUniqueViolation(err) {
  if (err.code !== '23505') return err;
  const c = err.constraint ?? '';
  if (c.includes('employee_number'))
    return conflict('EMPLOYEE_NUMBER_TAKEN', 'This employee ID is already in use');
  if (c.includes('mobile'))
    return conflict('MOBILE_TAKEN', 'Another employee already uses this mobile number');
  if (c.includes('user_id'))
    return conflict('USER_ALREADY_LINKED', 'This user account is already linked to an employee');
  return conflict('DUPLICATE', 'A record with these details already exists');
}

async function nextEmployeeNumber(trx, organizationId) {
  for (let attempt = 0; attempt < 20; attempt++) {
    // Atomic per-organization counter; concurrent creates get different numbers.
    const {
      rows: [{ seq }],
    } = await trx.raw(
      'UPDATE organizations SET next_employee_seq = next_employee_seq + 1 WHERE id = ? RETURNING next_employee_seq - 1 AS seq',
      [organizationId],
    );
    const candidate = `EMP-${String(seq).padStart(4, '0')}`;
    const taken = await trx('employees')
      .where({ organization_id: organizationId, employee_number: candidate })
      .first('id');
    if (!taken) return candidate;
  }
  throw new AppError(
    409,
    'EMPLOYEE_NUMBER_UNAVAILABLE',
    'Could not generate an employee ID; enter one',
  );
}

export function employeesRouter({ db }) {
  const router = Router();

  router.get('/', requirePermission(P.EMPLOYEES_READ), async (req, res) => {
    const q = validate(listQuery, req.query);
    const { rows, total } = await withTenant(db, req.auth.organizationId, async (trx) => {
      const query = scoped(baseQuery(trx, req.auth.organizationId), req.auth);
      if (q.branchId) query.where('e.branch_id', q.branchId);
      if (q.departmentId) query.where('e.department_id', q.departmentId);
      if (q.status !== 'all') query.where('e.employment_status', q.status);
      if (q.q) {
        const term = `%${q.q.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`;
        query.where((w) =>
          w
            .whereRaw('lower(e.full_name) LIKE ?', [term])
            .orWhereRaw('lower(e.employee_number) LIKE ?', [term]),
        );
      }
      const countQuery = query.clone().clearSelect().clearOrder().count({ n: 'e.id' }).first();
      const [rows, count] = await Promise.all([
        query.orderBy('e.full_name').limit(q.limit).offset(q.offset),
        countQuery,
      ]);
      return { rows, total: Number(count.n) };
    });
    res.json({
      data: rows.map((e) => present(e, req.auth)),
      total,
      limit: q.limit,
      offset: q.offset,
    });
  });

  router.get('/:id', requirePermission(P.EMPLOYEES_READ), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Employee not found');
    const row = await withTenant(db, req.auth.organizationId, (trx) =>
      scoped(baseQuery(trx, req.auth.organizationId), req.auth)
        .where('e.id', req.params.id)
        .first(),
    );
    if (!row) throw notFound('Employee not found');
    res.json(present(row, req.auth));
  });

  router.post('/', requirePermission(P.EMPLOYEES_MANAGE), async (req, res) => {
    const body = validate(createSchema, req.body);
    const created = await withTenant(db, req.auth.organizationId, async (trx) => {
      const values = toColumns(body);
      await assertReferences(trx, req.auth, values);
      const employeeNumber =
        body.employeeNumber ?? (await nextEmployeeNumber(trx, req.auth.organizationId));
      let row;
      try {
        [row] = await trx('employees')
          .insert({
            ...values,
            organization_id: req.auth.organizationId,
            employee_number: employeeNumber,
          })
          .returning('id');
      } catch (err) {
        throw translateUniqueViolation(err);
      }
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'employee.created',
        entityType: 'employee',
        entityId: row.id,
        metadata: { employeeNumber },
      });
      return baseQuery(trx, req.auth.organizationId).where('e.id', row.id).first();
    });
    res.status(201).json(present(created, req.auth));
  });

  router.patch('/:id', requirePermission(P.EMPLOYEES_MANAGE), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Employee not found');
    const body = validate(updateSchema, req.body);
    const updated = await withTenant(db, req.auth.organizationId, async (trx) => {
      const existing = await scoped(baseQuery(trx, req.auth.organizationId), req.auth)
        .where('e.id', req.params.id)
        .first();
      if (!existing) throw notFound('Employee not found');

      const values = toColumns(body);
      const status = values.employment_status ?? existing.employment_status;
      const exitDate = values.exit_date !== undefined ? values.exit_date : existing.exit_date;
      if (status === 'exited' && !exitDate) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'Exit date is required when an employee has exited',
        );
      }
      const joining = values.joining_date ?? existing.joining_date;
      if (exitDate && exitDate < joining) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Exit date cannot be before the joining date');
      }
      await assertReferences(trx, req.auth, values, existing.id);

      try {
        await trx('employees')
          .where({ organization_id: req.auth.organizationId, id: existing.id })
          .update({ ...values, updated_at: trx.fn.now() });
      } catch (err) {
        throw translateUniqueViolation(err);
      }
      await recordAudit(trx, {
        ...auditContext(req),
        action:
          values.employment_status && values.employment_status !== existing.employment_status
            ? `employee.status_${values.employment_status}`
            : 'employee.updated',
        entityType: 'employee',
        entityId: existing.id,
        // Field names only: values may be personal data.
        metadata: { fields: Object.keys(body) },
      });
      return baseQuery(trx, req.auth.organizationId).where('e.id', existing.id).first();
    });
    res.json(present(updated, req.auth));
  });

  return router;
}
