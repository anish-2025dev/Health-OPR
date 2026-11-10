import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { isUuid, withTenant } from '../../core/db.js';
import { AppError, conflict, notFound } from '../../core/errors.js';
import { auditContext, recordAudit } from '../audit/index.js';
import { PERMISSIONS, requirePermission } from '../staff-access/permissions.js';
import { loadComponents, setStatutoryProvider, structureOn } from '../hr-payroll/service.js';
import { RULE_CONFIG_SCHEMAS, computeStatutory, gratuityEstimate, ruleInForce } from './calc.js';

const P = PERMISSIONS;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const STATE = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Two-letter state code, e.g. KA');
const TYPES = ['epf', 'esi', 'professional_tax', 'lwf', 'gratuity'];
const STATE_RULES = ['professional_tax', 'lwf'];

const toRule = (r) => ({
  id: r.id,
  ruleType: r.rule_type,
  jurisdiction: r.jurisdiction,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  config: r.configuration_json,
  sourceReference: r.source_reference,
  approvalStatus: r.approval_status,
  createdBy: r.created_by_name ?? null,
  approvedBy: r.approved_by_name ?? null,
  approvedAt: r.approved_at,
});

const toStatutory = (s) =>
  s && {
    pfApplicable: s.pf_applicable,
    esiApplicable: s.esi_applicable,
    lwfApplicable: s.lwf_applicable,
    ptState: s.pt_state,
    tdsMonthlyAmount: s.tds_monthly_amount,
  };

const loadRules = async (trx, organizationId) =>
  (await trx('statutory_rules').where({ organization_id: organizationId })).map(toRule);

/** Registers statutory deductions with the payroll engine (rules are read inside the run's transaction). */
setStatutoryProvider(
  async (trx, { organizationId, run, emp, components, structure, metrics, settings }) => {
    const statutory = toStatutory(
      await trx('employee_statutory')
        .where({ organization_id: organizationId, employee_id: emp.id })
        .first(),
    );
    if (!statutory) return { lines: [], rules: [] };
    return computeStatutory({
      rules: await loadRules(trx, organizationId),
      statutory,
      components,
      structureAmounts: structure.amounts,
      metrics,
      settings,
      periodEnd: run.period_end,
    });
  },
);

const ruleSchema = z
  .object({
    ruleType: z.enum(TYPES),
    jurisdiction: STATE.default('IN'),
    effectiveFrom: DATE,
    effectiveTo: DATE.nullable().optional(),
    sourceReference: z
      .string()
      .trim()
      .min(3, 'Cite the notification, circular or adviser memo')
      .max(500),
    config: z.record(z.string(), z.unknown()),
  })
  .strict()
  .refine((v) => STATE_RULES.includes(v.ruleType) || v.jurisdiction === 'IN', {
    path: ['jurisdiction'],
    message: 'PF, ESI and gratuity rules are national (IN)',
  })
  .refine((v) => !STATE_RULES.includes(v.ruleType) || v.jurisdiction !== 'IN', {
    path: ['jurisdiction'],
    message: 'Professional tax and LWF rules need a state code',
  });

function validateConfig(type, config) {
  const parsed = RULE_CONFIG_SCHEMAS[type].safeParse(config);
  if (!parsed.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Rule configuration is invalid',
      parsed.error.issues.map((i) => ({ field: `config.${i.path.join('.')}`, message: i.message })),
    );
  }
  return parsed.data;
}

const rulesQuery = (trx, organizationId) =>
  trx('statutory_rules as r')
    .leftJoin('users as c', 'c.id', 'r.created_by_user_id')
    .leftJoin('users as a', 'a.id', 'r.approved_by_user_id')
    .where('r.organization_id', organizationId)
    .select('r.*', 'c.full_name as created_by_name', 'a.full_name as approved_by_name');

export function statutoryRouter({ db }) {
  const router = Router();
  router.use(requirePermission(P.PAYROLL_READ));

  router.get('/rules', async (req, res) => {
    const rows = await withTenant(db, req.auth.organizationId, (trx) =>
      rulesQuery(trx, req.auth.organizationId).orderBy([
        'r.rule_type',
        'r.jurisdiction',
        { column: 'r.effective_from', order: 'desc' },
      ]),
    );
    res.json({ data: rows.map(toRule) });
  });

  router.post('/rules', requirePermission(P.PAYROLL_MANAGE), async (req, res) => {
    const body = validate(ruleSchema, req.body);
    const config = validateConfig(body.ruleType, body.config);
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      const [created] = await trx('statutory_rules')
        .insert({
          organization_id: req.auth.organizationId,
          rule_type: body.ruleType,
          jurisdiction: body.jurisdiction,
          effective_from: body.effectiveFrom,
          effective_to: body.effectiveTo ?? null,
          configuration_json: config,
          source_reference: body.sourceReference,
          created_by_user_id: req.auth.userId,
        })
        .returning('*');
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'statutory.rule_drafted',
        entityType: 'statutory_rule',
        entityId: created.id,
        metadata: {
          ruleType: body.ruleType,
          jurisdiction: body.jurisdiction,
          effectiveFrom: body.effectiveFrom,
          config,
          sourceReference: body.sourceReference,
        },
      });
      return created;
    });
    res.status(201).json(toRule(row));
  });

  router.delete('/rules/:id', requirePermission(P.PAYROLL_MANAGE), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    await withTenant(db, req.auth.organizationId, async (trx) => {
      const rule = await trx('statutory_rules')
        .where({ organization_id: req.auth.organizationId, id: req.params.id })
        .first();
      if (!rule) throw notFound();
      if (rule.approval_status !== 'draft')
        throw conflict('RULE_APPROVED', 'Approved rules cannot be deleted; end them instead');
      await trx('statutory_rules').where({ id: rule.id }).delete();
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'statutory.rule_deleted',
        entityType: 'statutory_rule',
        entityId: rule.id,
      });
    });
    res.status(204).end();
  });

  /** Approval makes a rule live (and immutable). Overlapping approved versions are refused. */
  router.post('/rules/:id/approve', requirePermission(P.PAYROLL_APPROVE), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      const rule = await trx('statutory_rules')
        .where({ organization_id: req.auth.organizationId, id: req.params.id })
        .forUpdate()
        .first();
      if (!rule) throw notFound();
      if (rule.approval_status !== 'draft')
        throw conflict('NOT_DRAFT', 'Only draft rules can be approved');
      const overlap = await trx('statutory_rules')
        .where({
          organization_id: req.auth.organizationId,
          rule_type: rule.rule_type,
          jurisdiction: rule.jurisdiction,
          approval_status: 'approved',
        })
        .where((w) =>
          w.whereNull('effective_to').orWhere('effective_to', '>=', rule.effective_from),
        )
        .modify((q) => rule.effective_to && q.where('effective_from', '<=', rule.effective_to))
        .first('id', 'effective_from');
      if (overlap) {
        throw conflict(
          'RULE_OVERLAP',
          `An approved version from ${overlap.effective_from} is still in force. End it the day before ${rule.effective_from} first.`,
        );
      }
      await trx('statutory_rules')
        .where({ id: rule.id })
        .update({
          approval_status: 'approved',
          approved_by_user_id: req.auth.userId,
          approved_at: trx.fn.now(),
        });
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'statutory.rule_approved',
        entityType: 'statutory_rule',
        entityId: rule.id,
        metadata: {
          ruleType: rule.rule_type,
          jurisdiction: rule.jurisdiction,
          effectiveFrom: rule.effective_from,
        },
      });
      return rulesQuery(trx, req.auth.organizationId).where('r.id', rule.id).first();
    });
    res.json(toRule(row));
  });

  /** Ends an approved rule on a date (its terms stay unchanged for past payroll). */
  router.post('/rules/:id/end', requirePermission(P.PAYROLL_APPROVE), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body = validate(z.object({ effectiveTo: DATE }).strict(), req.body);
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      const rule = await trx('statutory_rules')
        .where({ organization_id: req.auth.organizationId, id: req.params.id })
        .forUpdate()
        .first();
      if (!rule) throw notFound();
      if (rule.approval_status !== 'approved')
        throw conflict('NOT_APPROVED', 'Only approved rules can be ended');
      if (body.effectiveTo < rule.effective_from)
        throw new AppError(400, 'VALIDATION_ERROR', 'End date is before the start date');
      const used = await trx('payroll_runs')
        .where({ organization_id: req.auth.organizationId, status: 'approved' })
        .where('period_end', '>', body.effectiveTo)
        .whereRaw(
          "EXISTS (SELECT 1 FROM payroll_items i WHERE i.payroll_run_id = payroll_runs.id AND i.calculation_snapshot -> 'statutoryRules' @> ?::jsonb)",
          [JSON.stringify([{ id: rule.id }])],
        )
        .first('id');
      if (used)
        throw conflict(
          'RULE_IN_USE',
          'Approved payroll after this date used this rule; choose a later end date',
        );
      await trx('statutory_rules')
        .where({ id: rule.id })
        .update({ effective_to: body.effectiveTo });
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'statutory.rule_ended',
        entityType: 'statutory_rule',
        entityId: rule.id,
        metadata: body,
      });
      return rulesQuery(trx, req.auth.organizationId).where('r.id', rule.id).first();
    });
    res.json(toRule(row));
  });

  // ---------------------------------------------------------------- employee enrolment
  router.get('/employees', async (req, res) => {
    const rows = await withTenant(db, req.auth.organizationId, (trx) =>
      trx('employees as e')
        .leftJoin('employee_statutory as s', 's.employee_id', 'e.id')
        .where('e.organization_id', req.auth.organizationId)
        .whereIn('e.employment_status', ['active', 'on_notice'])
        .modify((q) => req.auth.branchIds !== null && q.whereIn('e.branch_id', req.auth.branchIds))
        .orderBy('e.full_name')
        .select('e.id', 'e.full_name', 'e.employee_number', 's.*'),
    );
    res.json({
      data: rows.map((r) => ({
        employee: { id: r.id, fullName: r.full_name, employeeNumber: r.employee_number },
        statutory: toStatutory(r.employee_id ? r : null) ?? {
          pfApplicable: false,
          esiApplicable: false,
          lwfApplicable: false,
          ptState: null,
          tdsMonthlyAmount: null,
        },
      })),
    });
  });

  router.put('/employees/:employeeId', requirePermission(P.PAYROLL_MANAGE), async (req, res) => {
    if (!isUuid(req.params.employeeId)) throw notFound();
    const body = validate(
      z
        .object({
          pfApplicable: z.boolean(),
          esiApplicable: z.boolean(),
          lwfApplicable: z.boolean(),
          ptState: STATE.nullable(),
          tdsMonthlyAmount: z
            .string()
            .regex(/^\d{1,10}(\.\d{1,2})?$/)
            .nullable(),
        })
        .strict(),
      req.body,
    );
    await withTenant(db, req.auth.organizationId, async (trx) => {
      const emp = await trx('employees')
        .where({ organization_id: req.auth.organizationId, id: req.params.employeeId })
        .first('id', 'branch_id');
      if (!emp || (req.auth.branchIds !== null && !req.auth.branchIds.includes(emp.branch_id)))
        throw notFound('Employee not found');
      await trx('employee_statutory')
        .insert({
          employee_id: emp.id,
          organization_id: req.auth.organizationId,
          pf_applicable: body.pfApplicable,
          esi_applicable: body.esiApplicable,
          lwf_applicable: body.lwfApplicable,
          pt_state: body.ptState,
          tds_monthly_amount: body.tdsMonthlyAmount,
          updated_by_user_id: req.auth.userId,
          updated_at: trx.fn.now(),
        })
        .onConflict('employee_id')
        .merge();
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'statutory.employee_updated',
        entityType: 'employee',
        entityId: emp.id,
        metadata: body,
      });
    });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- gratuity tracking
  router.get('/gratuity', async (req, res) => {
    const q = validate(z.object({ asOf: DATE.optional() }), req.query);
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const asOf = q.asOf ?? new Date().toISOString().slice(0, 10);
      const rule = ruleInForce(
        await loadRules(trx, req.auth.organizationId),
        'gratuity',
        'IN',
        asOf,
      );
      if (!rule) return { asOf, rule: null, data: [] };
      const components = await loadComponents(trx, req.auth.organizationId);
      const employees = await trx('employees')
        .where({ organization_id: req.auth.organizationId })
        .whereIn('employment_status', ['active', 'on_notice'])
        .modify((qb) => req.auth.branchIds !== null && qb.whereIn('branch_id', req.auth.branchIds))
        .orderBy('full_name')
        .select('id', 'full_name', 'employee_number', 'joining_date');
      const data = [];
      for (const e of employees) {
        const s = await structureOn(trx, req.auth.organizationId, e.id, asOf);
        if (!s) continue;
        data.push({
          employee: {
            id: e.id,
            fullName: e.full_name,
            employeeNumber: e.employee_number,
            joiningDate: e.joining_date,
          },
          ...gratuityEstimate({
            rule,
            components,
            structureAmounts: s.amounts,
            joiningDate: e.joining_date,
            asOf,
          }),
        });
      }
      return {
        asOf,
        rule: {
          id: rule.id,
          effectiveFrom: rule.effectiveFrom,
          sourceReference: rule.sourceReference,
        },
        data,
      };
    });
    res.json(result);
  });

  // ---------------------------------------------------------------- statutory register for a run
  router.get('/runs/:runId.csv', async (req, res) => {
    if (!isUuid(req.params.runId)) throw notFound();
    const { rows, run } = await withTenant(db, req.auth.organizationId, async (trx) => {
      const r = await trx('payroll_runs')
        .where({ organization_id: req.auth.organizationId, id: req.params.runId })
        .first();
      if (!r) throw notFound();
      return {
        run: r,
        rows: await trx('payroll_items').where({
          organization_id: req.auth.organizationId,
          payroll_run_id: r.id,
        }),
      };
    });
    const codes = ['PF_EE', 'PF_ER', 'ESI_EE', 'ESI_ER', 'PT', 'LWF_EE', 'LWF_ER', 'TDS'];
    const lines = [
      ['Employee ID', 'Name', 'Gross', ...codes],
      ...rows.map((i) => {
        const s = i.calculation_snapshot;
        const amt = (code) => s.result.lines.find((l) => l.code === code)?.amount ?? '';
        return [
          s.employee.employeeNumber,
          s.employee.fullName,
          i.gross_earnings,
          ...codes.map(amt),
        ];
      }),
    ];
    const cell = (v) =>
      /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set(
      'Content-Disposition',
      `attachment; filename="statutory-${run.period_start.slice(0, 7)}.csv"`,
    );
    res.send(`${lines.map((l) => l.map(cell).join(',')).join('\r\n')}\r\n`);
  });

  return router;
}
