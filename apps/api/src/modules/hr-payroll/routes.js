import { Router } from 'express';
import { z } from 'zod';
import yazl from 'yazl';
import { validate } from '../../core/validate.js';
import { isUuid, withTenant } from '../../core/db.js';
import { AppError, conflict, notFound } from '../../core/errors.js';
import { auditContext, recordAudit } from '../audit/index.js';
import { createEmployeeMessage } from '../messages/index.js';
import { PERMISSIONS, requirePermission } from '../staff-access/permissions.js';
import { ENGINE_VERSION, fromPaise, toPaise } from './engine.js';
import { periodLabel, renderPayslip } from './payslip-pdf.js';
import {
  calculateRun,
  getPayrollSettings,
  loadComponents,
  periodOf,
  presentComponent,
  presentPolicy,
  presentSettings,
  previousDay,
  structureOn,
  verifyItem,
} from './service.js';

const P = PERMISSIONS;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const MONEY = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Amount like 15000 or 15000.50');
const PERCENT = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Percent like 40 or 12.5');
const CODE = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9_]{1,16}$/, 'Up to 16 letters, digits or _');
const UNIQUE = '23505';

const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const sendCsv = (res, filename, rows) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`\uFEFF${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`);
};

const presentRun = (r) => ({
  id: r.id,
  period: { start: r.period_start, end: r.period_end, label: periodLabel(r.period_start) },
  branchId: r.branch_id,
  branchName: r.branch_name ?? null,
  status: r.status,
  warnings: r.warnings,
  engineVersion: r.engine_version,
  calculatedAt: r.calculated_at,
  calculatedBy: r.calculated_by_name ?? null,
  approvedAt: r.approved_at,
  approvedBy: r.approved_by_name ?? null,
  notes: r.notes,
  totals:
    r.item_count !== undefined
      ? {
          employees: Number(r.item_count),
          gross: r.total_gross ?? '0.00',
          deductions: r.total_deductions ?? '0.00',
          net: r.total_net ?? '0.00',
        }
      : undefined,
  createdAt: r.created_at,
});

const presentItem = (i) => ({
  id: i.id,
  employee: i.calculation_snapshot.employee,
  grossEarnings: i.gross_earnings,
  totalDeductions: i.total_deductions,
  netPay: i.net_pay,
  lines: i.calculation_snapshot.result.lines,
  metrics: i.calculation_snapshot.inputs.metrics,
  dayRate: i.calculation_snapshot.result.dayRate,
  warnings: i.calculation_snapshot.result.warnings,
  paymentStatus: i.payment_status,
  paidAt: i.paid_at,
  paymentReference: i.payment_reference,
});

const runsQuery = (trx, organizationId) =>
  trx('payroll_runs as r')
    .leftJoin('branches as b', 'b.id', 'r.branch_id')
    .leftJoin('users as uc', 'uc.id', 'r.calculated_by_user_id')
    .leftJoin('users as ua', 'ua.id', 'r.approved_by_user_id')
    .leftJoin(
      trx('payroll_items')
        .where({ organization_id: organizationId })
        .groupBy('payroll_run_id')
        .select('payroll_run_id')
        .count({ item_count: '*' })
        .sum({
          total_gross: 'gross_earnings',
          total_deductions: 'total_deductions',
          total_net: 'net_pay',
        })
        .as('t'),
      't.payroll_run_id',
      'r.id',
    )
    .where('r.organization_id', organizationId)
    .select(
      'r.*',
      'b.name as branch_name',
      'uc.full_name as calculated_by_name',
      'ua.full_name as approved_by_name',
      trx.raw('coalesce(t.item_count, 0) as item_count'),
      't.total_gross',
      't.total_deductions',
      't.total_net',
    );

async function loadRun(trx, req, { forUpdate = false } = {}) {
  if (!isUuid(req.params.id)) throw notFound('Payroll run not found');
  const q = trx('payroll_runs').where({
    organization_id: req.auth.organizationId,
    id: req.params.id,
  });
  if (forUpdate) q.forUpdate();
  const run = await q.first();
  if (!run) throw notFound('Payroll run not found');
  if (req.auth.branchIds !== null && run.branch_id && !req.auth.branchIds.includes(run.branch_id)) {
    throw notFound('Payroll run not found');
  }
  return run;
}

const assertEditable = (run) => {
  if (run.status === 'approved') {
    throw conflict(
      'PAYROLL_APPROVED',
      'This payroll has been approved and can no longer change. Use an adjustment in the next payroll.',
    );
  }
};

const zipBuffer = (files) =>
  new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const f of files) zip.addBuffer(f.data, f.name);
    zip.end();
    const chunks = [];
    zip.outputStream.on('data', (c) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });

const payslipName = (item) => {
  const s = item.calculation_snapshot;
  const safe = s.employee.fullName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `payslip-${s.period.start.slice(0, 7)}-${s.employee.employeeNumber}-${safe}.pdf`;
};

// ================================================================== employee self-service (/me/payslips)

export function selfPayslipRouter({ db }) {
  const router = Router();
  router.use((req, res, next) =>
    req.auth.employee
      ? next()
      : next(
          new AppError(
            403,
            'NO_EMPLOYEE_PROFILE',
            'Your login is not linked to an employee profile',
          ),
        ),
  );

  /** Only the signed-in employee's own items, and only from approved payroll. */
  router.get('/', async (req, res) => {
    const rows = await withTenant(db, req.auth.organizationId, (trx) =>
      trx('payroll_items as i')
        .join('payroll_runs as r', 'r.id', 'i.payroll_run_id')
        .where({
          'i.organization_id': req.auth.organizationId,
          'i.employee_id': req.auth.employee.id,
          'r.status': 'approved',
        })
        .orderBy('r.period_start', 'desc')
        .select('i.*', 'r.period_start', 'r.period_end'),
    );
    res.json({
      data: rows.map((i) => ({
        ...presentItem(i),
        period: { start: i.period_start, end: i.period_end, label: periodLabel(i.period_start) },
      })),
    });
  });

  router.get('/:itemId/pdf', async (req, res) => {
    if (!isUuid(req.params.itemId)) throw notFound();
    const { buffer, name } = await withTenant(db, req.auth.organizationId, async (trx) => {
      const item = await trx('payroll_items as i')
        .join('payroll_runs as r', 'r.id', 'i.payroll_run_id')
        .where({
          'i.organization_id': req.auth.organizationId,
          'i.id': req.params.itemId,
          'i.employee_id': req.auth.employee.id,
          'r.status': 'approved',
        })
        .first('i.*');
      if (!item) throw notFound('Payslip not found');
      const run = await trx('payroll_runs').where({ id: item.payroll_run_id }).first();
      const org = await trx('organizations')
        .where({ id: req.auth.organizationId })
        .first('name', 'legal_name');
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'payroll.payslip_downloaded',
        entityType: 'payroll_item',
        entityId: item.id,
      });
      return {
        buffer: await renderPayslip({
          organization: { name: org.name, legalName: org.legal_name },
          item,
          run,
        }),
        name: payslipName(item),
      };
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.send(buffer);
  });

  return router;
}

// ================================================================== payroll admin (/payroll)

export function payrollRouter({ db }) {
  const router = Router();
  router.use(requirePermission(P.PAYROLL_READ));

  // ---------------------------------------------------------------- settings
  router.get('/settings', async (req, res) => {
    const s = await withTenant(db, req.auth.organizationId, (trx) =>
      getPayrollSettings(trx, req.auth.organizationId),
    );
    res.json(presentSettings(s));
  });

  router.put('/settings', requirePermission(P.PAYROLL_MANAGE), async (req, res) => {
    const body = validate(
      z
        .object({
          dayRateBasis: z.enum(['calendar_days', 'working_days', 'fixed_days']),
          fixedDays: z.number().int().min(20).max(31).nullable().optional(),
          incompleteDayLop: z.union([z.literal(0), z.literal(0.5), z.literal(1)]),
          reducedHoursLop: z.union([z.literal(0), z.literal(0.5), z.literal(1)]),
        })
        .strict()
        .refine((v) => v.dayRateBasis !== 'fixed_days' || v.fixedDays, {
          path: ['fixedDays'],
          message: 'Enter the number of days',
        }),
      req.body,
    );
    const s = await withTenant(db, req.auth.organizationId, async (trx) => {
      await getPayrollSettings(trx, req.auth.organizationId);
      const [row] = await trx('payroll_settings')
        .where({ organization_id: req.auth.organizationId })
        .update({
          day_rate_basis: body.dayRateBasis,
          fixed_days: body.dayRateBasis === 'fixed_days' ? body.fixedDays : null,
          incomplete_day_lop: body.incompleteDayLop,
          reduced_hours_lop: body.reducedHoursLop,
          updated_by_user_id: req.auth.userId,
          updated_at: trx.fn.now(),
        })
        .returning('*');
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'payroll.settings_updated',
        entityType: 'organization',
        entityId: req.auth.organizationId,
        metadata: body,
      });
      return row;
    });
    res.json(presentSettings(s));
  });

  // ---------------------------------------------------------------- components
  const componentSchema = z
    .object({
      name: z.string().trim().min(2).max(80),
      code: CODE,
      kind: z.enum(['earning', 'deduction']),
      calc: z.enum(['fixed', 'percent_of_component']).default('fixed'),
      percent: PERCENT.nullable().optional(),
      baseComponentId: z.string().uuid().nullable().optional(),
      includeInDayRate: z.boolean().default(true),
      displayOrder: z.number().int().min(0).max(1000).default(100),
    })
    .strict()
    .refine((v) => v.calc !== 'percent_of_component' || (v.percent && v.baseComponentId), {
      message: 'A percentage component needs a percent and a base component',
    });

  router.get('/components', async (req, res) => {
    const data = await withTenant(db, req.auth.organizationId, (trx) =>
      loadComponents(trx, req.auth.organizationId),
    );
    res.json({ data });
  });

  const saveComponent = async (trx, req, body, id) => {
    if (body.calc === 'percent_of_component' && body.baseComponentId) {
      const base = await trx('salary_components')
        .where({ organization_id: req.auth.organizationId, id: body.baseComponentId })
        .first();
      if (!base || base.calc !== 'fixed') {
        throw new AppError(400, 'VALIDATION_ERROR', 'The base must be a fixed-amount component');
      }
    }
    const values = {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.code !== undefined && { code: body.code }),
      ...(body.kind !== undefined && { kind: body.kind }),
      ...(body.calc !== undefined && { calc: body.calc }),
      ...(body.calc !== undefined && {
        percent: body.calc === 'percent_of_component' ? body.percent : null,
      }),
      ...(body.calc !== undefined && {
        base_component_id: body.calc === 'percent_of_component' ? body.baseComponentId : null,
      }),
      ...(body.includeInDayRate !== undefined && { include_in_day_rate: body.includeInDayRate }),
      ...(body.displayOrder !== undefined && { display_order: body.displayOrder }),
      ...(body.status !== undefined && { status: body.status }),
    };
    try {
      if (id) {
        const [row] = await trx('salary_components')
          .where({ organization_id: req.auth.organizationId, id })
          .update({ ...values, updated_at: trx.fn.now() })
          .returning('*');
        if (!row) throw notFound();
        return row;
      }
      const [row] = await trx('salary_components')
        .insert({ organization_id: req.auth.organizationId, ...values })
        .returning('*');
      return row;
    } catch (err) {
      if (err.code === UNIQUE)
        throw conflict('CODE_TAKEN', 'A component with this code already exists');
      throw err;
    }
  };

  router.post('/components', requirePermission(P.PAYROLL_MANAGE), async (req, res) => {
    const body = validate(componentSchema, req.body);
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      const r = await saveComponent(trx, req, body);
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'payroll.component_created',
        entityType: 'salary_component',
        entityId: r.id,
        metadata: body,
      });
      return r;
    });
    res.status(201).json(presentComponent(row));
  });

  router.patch('/components/:id', requirePermission(P.PAYROLL_MANAGE), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body = validate(
      z
        .object({
          name: z.string().trim().min(2).max(80).optional(),
          includeInDayRate: z.boolean().optional(),
          displayOrder: z.number().int().min(0).max(1000).optional(),
          status: z.enum(['active', 'inactive']).optional(),
        })
        .strict(),
      req.body,
    );
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      const r = await saveComponent(trx, req, body, req.params.id);
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'payroll.component_updated',
        entityType: 'salary_component',
        entityId: r.id,
        metadata: body,
      });
      return r;
    });
    res.json(presentComponent(row));
  });

  // ---------------------------------------------------------------- salary structures
  router.get('/structures', async (req, res) => {
    const q = validate(z.object({ date: DATE.optional() }), req.query);
    const data = await withTenant(db, req.auth.organizationId, async (trx) => {
      const date = q.date ?? new Date().toISOString().slice(0, 10);
      const components = await loadComponents(trx, req.auth.organizationId);
      const employees = await trx('employees')
        .where({ organization_id: req.auth.organizationId })
        .whereIn('employment_status', ['active', 'on_notice'])
        .modify((qb) => req.auth.branchIds !== null && qb.whereIn('branch_id', req.auth.branchIds))
        .orderBy('full_name')
        .select('id', 'full_name', 'employee_number');
      const out = [];
      for (const e of employees) {
        const s = await structureOn(trx, req.auth.organizationId, e.id, date);
        const monthly = s
          ? components
              .filter((c) => c.kind === 'earning' && c.calc === 'fixed' && s.amounts[c.id])
              .reduce((a, c) => a + Number(s.amounts[c.id]), 0)
          : null;
        out.push({
          employee: { id: e.id, fullName: e.full_name, employeeNumber: e.employee_number },
          structure: s,
          fixedEarnings: monthly === null ? null : monthly.toFixed(2),
        });
      }
      return out;
    });
    res.json({ data });
  });

  router.get('/structures/:employeeId/history', async (req, res) => {
    if (!isUuid(req.params.employeeId)) throw notFound();
    const data = await withTenant(db, req.auth.organizationId, async (trx) => {
      const emp = await trx('employees')
        .where({ organization_id: req.auth.organizationId, id: req.params.employeeId })
        .first('branch_id');
      if (!emp || (req.auth.branchIds !== null && !req.auth.branchIds.includes(emp.branch_id)))
        throw notFound();
      const structures = await trx('salary_structures as s')
        .leftJoin('users as u', 'u.id', 's.created_by_user_id')
        .where({
          's.organization_id': req.auth.organizationId,
          's.employee_id': req.params.employeeId,
        })
        .orderBy('s.effective_from', 'desc')
        .select('s.*', 'u.full_name as created_by_name');
      const lines = structures.length
        ? await trx('salary_structure_lines')
            .where({ organization_id: req.auth.organizationId })
            .whereIn(
              'structure_id',
              structures.map((s) => s.id),
            )
        : [];
      return structures.map((s) => ({
        id: s.id,
        effectiveFrom: s.effective_from,
        effectiveTo: s.effective_to,
        note: s.note,
        createdBy: s.created_by_name,
        createdAt: s.created_at,
        amounts: Object.fromEntries(
          lines.filter((l) => l.structure_id === s.id).map((l) => [l.component_id, l.amount]),
        ),
      }));
    });
    res.json({ data });
  });

  /** A new structure from a date; the previous open structure ends the day before (salary revision). */
  router.post('/structures', requirePermission(P.PAYROLL_MANAGE), async (req, res) => {
    const body = validate(
      z
        .object({
          employeeId: z.string().uuid(),
          effectiveFrom: DATE,
          note: z.string().trim().max(300).optional(),
          lines: z
            .array(z.object({ componentId: z.string().uuid(), amount: MONEY }))
            .min(1)
            .max(40),
        })
        .strict(),
      req.body,
    );
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const emp = await trx('employees')
        .where({ organization_id: req.auth.organizationId, id: body.employeeId })
        .forUpdate()
        .first('id', 'branch_id', 'joining_date');
      if (!emp || (req.auth.branchIds !== null && !req.auth.branchIds.includes(emp.branch_id)))
        throw notFound('Employee not found');
      const components = await loadComponents(trx, req.auth.organizationId);
      for (const l of body.lines) {
        const c = components.find((x) => x.id === l.componentId);
        if (!c || c.status !== 'active' || c.calc !== 'fixed') {
          throw new AppError(
            400,
            'VALIDATION_ERROR',
            'Each line must be an active fixed-amount component',
          );
        }
      }
      const later = await trx('salary_structures')
        .where({ organization_id: req.auth.organizationId, employee_id: emp.id })
        .where('effective_from', '>=', body.effectiveFrom)
        .first('id');
      if (later)
        throw conflict(
          'LATER_STRUCTURE_EXISTS',
          'A salary structure already starts on or after this date',
        );
      const approved = await trx('payroll_items as i')
        .join('payroll_runs as r', 'r.id', 'i.payroll_run_id')
        .where({
          'i.organization_id': req.auth.organizationId,
          'i.employee_id': emp.id,
          'r.status': 'approved',
        })
        .where('r.period_end', '>=', body.effectiveFrom)
        .first('r.id');
      if (approved)
        throw conflict(
          'PAYROLL_LOCKED',
          'Payroll after this date is already approved; choose a later date and use an adjustment for arrears',
        );

      await trx('salary_structures')
        .where({ organization_id: req.auth.organizationId, employee_id: emp.id })
        .whereNull('effective_to')
        .update({ effective_to: previousDay(body.effectiveFrom) });
      const [s] = await trx('salary_structures')
        .insert({
          organization_id: req.auth.organizationId,
          employee_id: emp.id,
          effective_from: body.effectiveFrom,
          note: body.note ?? null,
          created_by_user_id: req.auth.userId,
        })
        .returning('*');
      await trx('salary_structure_lines').insert(
        body.lines.map((l) => ({
          organization_id: req.auth.organizationId,
          structure_id: s.id,
          component_id: l.componentId,
          amount: l.amount,
        })),
      );
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'payroll.salary_structure_created',
        entityType: 'employee',
        entityId: emp.id,
        metadata: { structureId: s.id, effectiveFrom: body.effectiveFrom, lines: body.lines },
      });
      return s;
    });
    res.status(201).json({ id: result.id, effectiveFrom: result.effective_from });
  });

  // ---------------------------------------------------------------- pay policies
  const policySchema = z
    .object({
      name: z.string().trim().min(2).max(80),
      code: CODE,
      kind: z.enum(['earning', 'deduction']),
      calc: z.enum(['fixed', 'percent_of_component', 'per_unit']),
      amount: MONEY.nullable().optional(),
      percent: PERCENT.nullable().optional(),
      baseComponentId: z.string().uuid().nullable().optional(),
      unitMetric: z
        .enum([
          'lop_days',
          'absent_days',
          'half_days',
          'late_beyond_free',
          'reduced_hour_days',
          'overtime_hours',
          'incomplete_days',
        ])
        .nullable()
        .optional(),
      unitRate: z.enum(['fixed_amount', 'day_rate', 'hourly_rate']).nullable().optional(),
      multiplier: z
        .string()
        .regex(/^\d{1,2}(\.\d{1,3})?$/)
        .default('1'),
      frequency: z.enum(['monthly', 'one_time', 'installments']).default('monthly'),
      installments: z.number().int().min(1).max(120).nullable().optional(),
      appliesTo: z.enum(['all', 'branch', 'department', 'employees']).default('all'),
      appliesToIds: z.array(z.string().uuid()).max(500).default([]),
      effectiveFrom: DATE,
      effectiveTo: DATE.nullable().optional(),
    })
    .strict()
    .refine((v) => v.calc !== 'fixed' || v.amount, {
      path: ['amount'],
      message: 'Enter the amount',
    })
    .refine((v) => v.calc !== 'percent_of_component' || (v.percent && v.baseComponentId), {
      path: ['percent'],
      message: 'Enter the percent and the component',
    })
    .refine((v) => v.calc !== 'per_unit' || (v.unitMetric && v.unitRate), {
      path: ['unitMetric'],
      message: 'Choose what is counted and the rate',
    })
    .refine((v) => v.unitRate !== 'fixed_amount' || v.amount, {
      path: ['amount'],
      message: 'Enter the amount per unit',
    })
    .refine((v) => v.frequency !== 'installments' || v.installments, {
      path: ['installments'],
      message: 'Enter the number of instalments',
    })
    .refine((v) => v.appliesTo === 'all' || v.appliesToIds.length > 0, {
      path: ['appliesToIds'],
      message: 'Choose who this applies to',
    });

  router.get('/policies', async (req, res) => {
    const rows = await withTenant(db, req.auth.organizationId, (trx) =>
      trx('pay_policies').where({ organization_id: req.auth.organizationId }).orderBy('name'),
    );
    res.json({ data: rows.map(presentPolicy) });
  });

  router.post('/policies', requirePermission(P.PAYROLL_MANAGE), async (req, res) => {
    const body = validate(policySchema, req.body);
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      let created;
      try {
        [created] = await trx('pay_policies')
          .insert({
            organization_id: req.auth.organizationId,
            name: body.name,
            code: body.code,
            kind: body.kind,
            calc: body.calc,
            amount: body.amount ?? null,
            percent: body.calc === 'percent_of_component' ? body.percent : null,
            base_component_id: body.calc === 'percent_of_component' ? body.baseComponentId : null,
            unit_metric: body.calc === 'per_unit' ? body.unitMetric : null,
            unit_rate: body.calc === 'per_unit' ? body.unitRate : null,
            multiplier: body.multiplier,
            frequency: body.frequency,
            installments: body.frequency === 'installments' ? body.installments : null,
            applies_to: body.appliesTo,
            applies_to_ids: body.appliesTo === 'all' ? [] : body.appliesToIds,
            effective_from: body.effectiveFrom,
            effective_to: body.effectiveTo ?? null,
          })
          .returning('*');
      } catch (err) {
        if (err.code === UNIQUE)
          throw conflict('CODE_TAKEN', 'A policy with this code already exists');
        throw err;
      }
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'payroll.policy_created',
        entityType: 'pay_policy',
        entityId: created.id,
        metadata: body,
      });
      return created;
    });
    res.status(201).json(presentPolicy(row));
  });

  router.patch('/policies/:id', requirePermission(P.PAYROLL_MANAGE), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body = validate(
      z
        .object({
          status: z.enum(['active', 'inactive']).optional(),
          effectiveTo: DATE.nullable().optional(),
          name: z.string().trim().min(2).max(80).optional(),
        })
        .strict(),
      req.body,
    );
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      const [updated] = await trx('pay_policies')
        .where({ organization_id: req.auth.organizationId, id: req.params.id })
        .update({
          ...(body.status && { status: body.status }),
          ...(body.effectiveTo !== undefined && { effective_to: body.effectiveTo }),
          ...(body.name && { name: body.name }),
          updated_at: trx.fn.now(),
        })
        .returning('*');
      if (!updated) throw notFound();
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'payroll.policy_updated',
        entityType: 'pay_policy',
        entityId: updated.id,
        metadata: body,
      });
      return updated;
    });
    res.json(presentPolicy(row));
  });

  // ---------------------------------------------------------------- runs
  router.get('/runs', async (req, res) => {
    const rows = await withTenant(db, req.auth.organizationId, (trx) =>
      runsQuery(trx, req.auth.organizationId)
        .modify(
          (q) =>
            req.auth.branchIds !== null &&
            q.where((w) => w.whereNull('r.branch_id').orWhereIn('r.branch_id', req.auth.branchIds)),
        )
        .orderBy('r.period_start', 'desc')
        .limit(60),
    );
    res.json({ data: rows.map(presentRun) });
  });

  router.post('/runs', requirePermission(P.PAYROLL_MANAGE), async (req, res) => {
    const body = validate(
      z
        .object({
          month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
          branchId: z.string().uuid().nullable().optional(),
          notes: z.string().trim().max(300).optional(),
        })
        .strict(),
      req.body,
    );
    const run = await withTenant(db, req.auth.organizationId, async (trx) => {
      if (body.branchId) {
        const b = await trx('branches')
          .where({ organization_id: req.auth.organizationId, id: body.branchId })
          .first('id');
        if (!b) throw new AppError(400, 'VALIDATION_ERROR', 'Unknown branch');
      }
      if (
        req.auth.branchIds !== null &&
        (!body.branchId || !req.auth.branchIds.includes(body.branchId))
      ) {
        throw new AppError(403, 'FORBIDDEN', 'You can only run payroll for your branch');
      }
      const { start, end } = periodOf(body.month);
      let created;
      try {
        [created] = await trx('payroll_runs')
          .insert({
            organization_id: req.auth.organizationId,
            branch_id: body.branchId ?? null,
            period_start: start,
            period_end: end,
            notes: body.notes ?? null,
            created_by_user_id: req.auth.userId,
          })
          .returning('*');
      } catch (err) {
        if (err.code === UNIQUE)
          throw conflict('RUN_EXISTS', 'A payroll run for this month already exists');
        throw err;
      }
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'payroll.run_created',
        entityType: 'payroll_run',
        entityId: created.id,
        metadata: { month: body.month, branchId: body.branchId ?? null },
      });
      return created;
    });
    res.status(201).json(presentRun(run));
  });

  router.get('/runs/:id', async (req, res) => {
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const run = await loadRun(trx, req);
      const full = await runsQuery(trx, req.auth.organizationId).where('r.id', run.id).first();
      const items = await trx('payroll_items').where({
        organization_id: req.auth.organizationId,
        payroll_run_id: run.id,
      });
      const adjustments = await trx('payroll_adjustments as a')
        .join('employees as e', 'e.id', 'a.employee_id')
        .where({ 'a.organization_id': req.auth.organizationId, 'a.payroll_run_id': run.id })
        .select('a.*', 'e.full_name as employee_name');
      return {
        ...presentRun(full),
        items: items
          .map(presentItem)
          .sort((a, b) => a.employee.fullName.localeCompare(b.employee.fullName)),
        adjustments: adjustments.map((a) => ({
          id: a.id,
          employeeId: a.employee_id,
          employeeName: a.employee_name,
          kind: a.kind,
          label: a.label,
          amount: a.amount,
          reason: a.reason,
        })),
      };
    });
    res.json(result);
  });

  router.delete('/runs/:id', requirePermission(P.PAYROLL_MANAGE), async (req, res) => {
    await withTenant(db, req.auth.organizationId, async (trx) => {
      const run = await loadRun(trx, req, { forUpdate: true });
      assertEditable(run);
      await trx('payroll_runs').where({ id: run.id }).delete();
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'payroll.run_deleted',
        entityType: 'payroll_run',
        entityId: run.id,
      });
    });
    res.status(204).end();
  });

  router.post('/runs/:id/calculate', requirePermission(P.PAYROLL_MANAGE), async (req, res) => {
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const run = await loadRun(trx, req, { forUpdate: true });
      assertEditable(run);
      const { count, warnings, settings } = await calculateRun(trx, {
        organizationId: req.auth.organizationId,
        run,
      });
      await trx('payroll_runs')
        .where({ id: run.id })
        .update({
          status: 'calculated',
          warnings: JSON.stringify(warnings),
          settings_snapshot: settings,
          engine_version: ENGINE_VERSION,
          calculated_by_user_id: req.auth.userId,
          calculated_at: trx.fn.now(),
        });
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'payroll.run_calculated',
        entityType: 'payroll_run',
        entityId: run.id,
        metadata: { employees: count, warnings: warnings.length },
      });
      return { employees: count, warnings };
    });
    res.json(result);
  });

  router.post('/runs/:id/adjustments', requirePermission(P.PAYROLL_MANAGE), async (req, res) => {
    const body = validate(
      z
        .object({
          employeeId: z.string().uuid(),
          kind: z.enum(['earning', 'deduction']),
          label: z.string().trim().min(2).max(80),
          amount: MONEY.refine((v) => Number(v) > 0, 'Must be more than zero'),
          reason: z.string().trim().min(3).max(300),
        })
        .strict(),
      req.body,
    );
    await withTenant(db, req.auth.organizationId, async (trx) => {
      const run = await loadRun(trx, req, { forUpdate: true });
      assertEditable(run);
      const emp = await trx('employees')
        .where({ organization_id: req.auth.organizationId, id: body.employeeId })
        .first('id', 'branch_id');
      if (!emp || (run.branch_id && emp.branch_id !== run.branch_id))
        throw new AppError(400, 'VALIDATION_ERROR', 'Employee is not in this payroll');
      const [row] = await trx('payroll_adjustments')
        .insert({
          organization_id: req.auth.organizationId,
          payroll_run_id: run.id,
          employee_id: emp.id,
          kind: body.kind,
          label: body.label,
          amount: body.amount,
          reason: body.reason,
          created_by_user_id: req.auth.userId,
        })
        .returning('id');
      // Totals are stale until recalculated.
      await trx('payroll_runs').where({ id: run.id }).update({ status: 'draft' });
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'payroll.adjustment_added',
        entityType: 'payroll_run',
        entityId: run.id,
        reason: body.reason,
        metadata: {
          adjustmentId: row.id,
          employeeId: emp.id,
          kind: body.kind,
          amount: body.amount,
        },
      });
    });
    res.status(201).json({ ok: true, status: 'draft' });
  });

  router.delete(
    '/runs/:id/adjustments/:adjId',
    requirePermission(P.PAYROLL_MANAGE),
    async (req, res) => {
      if (!isUuid(req.params.adjId)) throw notFound();
      await withTenant(db, req.auth.organizationId, async (trx) => {
        const run = await loadRun(trx, req, { forUpdate: true });
        assertEditable(run);
        const n = await trx('payroll_adjustments')
          .where({
            organization_id: req.auth.organizationId,
            payroll_run_id: run.id,
            id: req.params.adjId,
          })
          .delete();
        if (!n) throw notFound();
        await trx('payroll_runs').where({ id: run.id }).update({ status: 'draft' });
        await recordAudit(trx, {
          ...auditContext(req),
          action: 'payroll.adjustment_removed',
          entityType: 'payroll_run',
          entityId: run.id,
          metadata: { adjustmentId: req.params.adjId },
        });
      });
      res.status(204).end();
    },
  );

  /** Final approval: payroll becomes immutable and payslips are released to employees. */
  router.post('/runs/:id/approve', requirePermission(P.PAYROLL_APPROVE), async (req, res) => {
    const body = validate(
      z.object({ confirm: z.literal(true, { message: 'Confirm approval' }) }).strict(),
      req.body,
    );
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const run = await loadRun(trx, req, { forUpdate: true });
      if (run.status !== 'calculated') {
        throw conflict(
          run.status === 'approved' ? 'PAYROLL_APPROVED' : 'NOT_CALCULATED',
          run.status === 'approved'
            ? 'Already approved'
            : 'Calculate the payroll before approving it',
        );
      }
      const count = await trx('payroll_items')
        .where({ payroll_run_id: run.id })
        .count({ n: '*' })
        .first();
      if (Number(count.n) === 0) throw conflict('EMPTY_RUN', 'This payroll has no employees');
      await trx('payroll_runs').where({ id: run.id }).update({
        status: 'approved',
        approved_by_user_id: req.auth.userId,
        approved_at: trx.fn.now(),
      });
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'payroll.run_approved',
        entityType: 'payroll_run',
        entityId: run.id,
        metadata: { confirm: body.confirm, employees: Number(count.n) },
      });
      // Tell each employee their payslip is ready (in-app; amounts stay on the payslip).
      const employeeIds = await trx('payroll_items')
        .where({ payroll_run_id: run.id })
        .pluck('employee_id');
      const period = new Date(`${run.period_start}T00:00:00Z`).toLocaleDateString('en-IN', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      });
      await createEmployeeMessage(trx, req.auth.organizationId, {
        senderUserId: req.auth.userId,
        senderLabel: 'Payroll',
        category: 'payroll',
        title: `Your payslip for ${period} is ready`,
        body: 'Open My payslips to view or download it. Contact HR if anything looks wrong.',
        audienceType: 'system',
        audienceLabel: `Payroll ${period}`,
        employeeIds,
      });
      return runsQuery(trx, req.auth.organizationId).where('r.id', run.id).first();
    });
    res.json(presentRun(result));
  });

  router.post('/runs/:id/payments', requirePermission(P.PAYROLL_PAY), async (req, res) => {
    const body = validate(
      z
        .object({
          itemIds: z.array(z.string().uuid()).min(1).max(1000),
          status: z.enum(['paid', 'failed', 'on_hold', 'pending']),
          reference: z.string().trim().max(100).optional(),
        })
        .strict(),
      req.body,
    );
    const updated = await withTenant(db, req.auth.organizationId, async (trx) => {
      const run = await loadRun(trx, req);
      if (run.status !== 'approved')
        throw conflict('NOT_APPROVED', 'Payments can be recorded only after approval');
      const n = await trx('payroll_items')
        .where({ organization_id: req.auth.organizationId, payroll_run_id: run.id })
        .whereIn('id', body.itemIds)
        .update({
          payment_status: body.status,
          paid_at: body.status === 'paid' ? trx.fn.now() : null,
          payment_reference: body.reference ?? null,
          payment_updated_by_user_id: req.auth.userId,
        });
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'payroll.payment_recorded',
        entityType: 'payroll_run',
        entityId: run.id,
        metadata: { items: n, status: body.status, reference: body.reference ?? null },
      });
      return n;
    });
    res.json({ updated });
  });

  router.get('/runs/:id/items/:itemId/verify', async (req, res) => {
    if (!isUuid(req.params.itemId)) throw notFound();
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const run = await loadRun(trx, req);
      const item = await trx('payroll_items')
        .where({
          organization_id: req.auth.organizationId,
          payroll_run_id: run.id,
          id: req.params.itemId,
        })
        .first();
      if (!item) throw notFound();
      return verifyItem(item);
    });
    res.json(result);
  });

  const loadPayslipContext = async (trx, req) => {
    const run = await loadRun(trx, req);
    if (run.status !== 'approved')
      throw conflict('NOT_APPROVED', 'Payslips are available after approval');
    const org = await trx('organizations')
      .where({ id: req.auth.organizationId })
      .first('name', 'legal_name');
    return { run, organization: { name: org.name, legalName: org.legal_name } };
  };

  router.get('/runs/:id/items/:itemId/payslip.pdf', async (req, res) => {
    if (!isUuid(req.params.itemId)) throw notFound();
    const { buffer, name } = await withTenant(db, req.auth.organizationId, async (trx) => {
      const { run, organization } = await loadPayslipContext(trx, req);
      const item = await trx('payroll_items')
        .where({
          organization_id: req.auth.organizationId,
          payroll_run_id: run.id,
          id: req.params.itemId,
        })
        .first();
      if (!item) throw notFound();
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'payroll.payslip_downloaded',
        entityType: 'payroll_item',
        entityId: item.id,
      });
      return { buffer: await renderPayslip({ organization, item, run }), name: payslipName(item) };
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.send(buffer);
  });

  router.get('/runs/:id/payslips.zip', async (req, res) => {
    const { buffer, name } = await withTenant(db, req.auth.organizationId, async (trx) => {
      const { run, organization } = await loadPayslipContext(trx, req);
      const items = await trx('payroll_items').where({
        organization_id: req.auth.organizationId,
        payroll_run_id: run.id,
      });
      const files = [];
      for (const item of items)
        files.push({
          name: payslipName(item),
          data: await renderPayslip({ organization, item, run }),
        });
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'payroll.payslips_bulk_downloaded',
        entityType: 'payroll_run',
        entityId: run.id,
        metadata: { files: files.length },
      });
      return {
        buffer: await zipBuffer(files),
        name: `payslips-${run.period_start.slice(0, 7)}.zip`,
      };
    });
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.send(buffer);
  });

  router.get('/runs/:id/export.csv', async (req, res) => {
    const { rows, run } = await withTenant(db, req.auth.organizationId, async (trx) => {
      const r = await loadRun(trx, req);
      const items = await trx('payroll_items').where({
        organization_id: req.auth.organizationId,
        payroll_run_id: r.id,
      });
      return { rows: items, run: r };
    });
    const codes = [
      ...new Set(
        rows.flatMap((i) =>
          i.calculation_snapshot.result.lines.map(
            (l) => `${l.kind === 'earning' ? '+' : '-'}${l.code}`,
          ),
        ),
      ),
    ];
    const header = [
      'Employee ID',
      'Name',
      'Department',
      'LOP days',
      ...codes,
      'Gross',
      'Deductions',
      'Net pay',
      'Payment status',
      'Payment reference',
    ];
    const body = rows
      .sort((a, b) =>
        a.calculation_snapshot.employee.fullName.localeCompare(
          b.calculation_snapshot.employee.fullName,
        ),
      )
      .map((i) => {
        const s = i.calculation_snapshot;
        const amountFor = (key) =>
          fromPaise(
            s.result.lines
              .filter((l) => `${l.kind === 'earning' ? '+' : '-'}${l.code}` === key)
              .reduce((a, l) => a + toPaise(l.amount), 0n),
          );
        return [
          s.employee.employeeNumber,
          s.employee.fullName,
          s.employee.department ?? '',
          s.inputs.metrics.lopDays,
          ...codes.map((c) => amountFor(c)),
          i.gross_earnings,
          i.total_deductions,
          i.net_pay,
          i.payment_status,
          i.payment_reference ?? '',
        ];
      });
    sendCsv(res, `payroll-${run.period_start.slice(0, 7)}.csv`, [header, ...body]);
  });

  return router;
}
