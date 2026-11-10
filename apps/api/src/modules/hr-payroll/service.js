import { addDays, monthEnd } from '../hr-attendance/calc.js';
import { buildMonth, getPolicy, loadEmployee, todayFor } from '../hr-attendance/service.js';
import { attendanceMetrics, computePayslip } from './engine.js';

// ------------------------------------------------------------------ settings & components

export async function getPayrollSettings(trx, organizationId) {
  let row = await trx('payroll_settings').where({ organization_id: organizationId }).first();
  if (!row) {
    await trx('payroll_settings')
      .insert({ organization_id: organizationId })
      .onConflict('organization_id')
      .ignore();
    row = await trx('payroll_settings').where({ organization_id: organizationId }).first();
  }
  return row;
}

export const presentSettings = (s) => ({
  dayRateBasis: s.day_rate_basis,
  fixedDays: s.fixed_days,
  incompleteDayLop: Number(s.incomplete_day_lop),
  reducedHoursLop: Number(s.reduced_hours_lop),
  updatedAt: s.updated_at,
});

export const presentComponent = (c) => ({
  id: c.id,
  name: c.name,
  code: c.code,
  kind: c.kind,
  calc: c.calc,
  percent: c.percent === null ? null : String(Number(c.percent)),
  baseComponentId: c.base_component_id,
  includeInDayRate: c.include_in_day_rate,
  displayOrder: c.display_order,
  status: c.status,
});

export async function loadComponents(trx, organizationId) {
  const rows = await trx('salary_components')
    .where({ organization_id: organizationId })
    .orderBy(['display_order', 'code']);
  return rows.map(presentComponent);
}

// ------------------------------------------------------------------ structures

/** The structure in force on `date` (latest effective_from on or before it). */
export async function structureOn(trx, organizationId, employeeId, date) {
  const s = await trx('salary_structures')
    .where({ organization_id: organizationId, employee_id: employeeId })
    .where('effective_from', '<=', date)
    .where((w) => w.whereNull('effective_to').orWhere('effective_to', '>=', date))
    .orderBy('effective_from', 'desc')
    .first();
  if (!s) return null;
  const lines = await trx('salary_structure_lines').where({
    organization_id: organizationId,
    structure_id: s.id,
  });
  return {
    id: s.id,
    effectiveFrom: s.effective_from,
    effectiveTo: s.effective_to,
    note: s.note,
    amounts: Object.fromEntries(lines.map((l) => [l.component_id, l.amount])),
  };
}

// ------------------------------------------------------------------ policies

export const presentPolicy = (p) => ({
  id: p.id,
  name: p.name,
  code: p.code,
  kind: p.kind,
  calc: p.calc,
  amount: p.amount,
  percent: p.percent === null ? null : String(Number(p.percent)),
  baseComponentId: p.base_component_id,
  unitMetric: p.unit_metric,
  unitRate: p.unit_rate,
  multiplier: String(Number(p.multiplier)),
  frequency: p.frequency,
  installments: p.installments,
  appliesTo: p.applies_to,
  appliesToIds: p.applies_to_ids,
  effectiveFrom: p.effective_from,
  effectiveTo: p.effective_to,
  status: p.status,
});

/** Active policies that apply to this employee in the period, with instalments already used. */
export async function applicablePolicies(
  trx,
  { organizationId, employee, periodStart, periodEnd },
) {
  const rows = await trx('pay_policies')
    .where({ organization_id: organizationId, status: 'active' })
    .where('effective_from', '<=', periodEnd)
    .where((w) => w.whereNull('effective_to').orWhere('effective_to', '>=', periodStart));
  const result = [];
  for (const p of rows) {
    const ids = p.applies_to_ids ?? [];
    const applies =
      p.applies_to === 'all' ||
      (p.applies_to === 'branch' && ids.includes(employee.branchId)) ||
      (p.applies_to === 'department' && ids.includes(employee.departmentId)) ||
      (p.applies_to === 'employees' && ids.includes(employee.id));
    if (!applies) continue;
    let installmentsUsed = 0;
    if (p.frequency !== 'monthly') {
      const { rows: used } = await trx.raw(
        `SELECT count(*)::int AS n FROM payroll_items i JOIN payroll_runs r ON r.id = i.payroll_run_id
          WHERE i.organization_id = ? AND i.employee_id = ? AND r.status = 'approved'
            AND i.calculation_snapshot -> 'result' -> 'lines' @> ?::jsonb`,
        [organizationId, employee.id, JSON.stringify([{ policyId: p.id }])],
      );
      installmentsUsed = used[0].n;
      if (p.frequency === 'one_time' && installmentsUsed >= 1) continue;
      if (p.frequency === 'installments' && installmentsUsed >= p.installments) continue;
    }
    result.push({ ...presentPolicy(p), installmentsUsed });
  }
  return result;
}

export { assertNotPayrollLocked } from './lock.js';

// ------------------------------------------------------------------ run calculation

/** Hook for statutory deductions (Phase 11). Returns precomputed lines. */
let statutoryProvider = async () => ({ lines: [], rules: [] });
export const setStatutoryProvider = (fn) => {
  statutoryProvider = fn;
};

export async function calculateRun(trx, { organizationId, run }) {
  const settingsRow = await getPayrollSettings(trx, organizationId);
  const settings = presentSettings(settingsRow);
  const attendancePolicy = await getPolicy(trx, organizationId);
  const components = (await loadComponents(trx, organizationId)).filter(
    (c) => c.status === 'active',
  );
  const month = run.period_start.slice(0, 7);

  const employees = await trx('employees')
    .where({ organization_id: organizationId })
    .where('joining_date', '<=', run.period_end)
    .where((w) => w.whereNull('exit_date').orWhere('exit_date', '>=', run.period_start))
    .modify((q) => run.branch_id && q.where('branch_id', run.branch_id))
    .orderBy('full_name')
    .pluck('id');

  await trx('payroll_items')
    .where({ organization_id: organizationId, payroll_run_id: run.id })
    .delete();

  const warnings = [];
  let count = 0;
  for (const employeeId of employees) {
    const emp = await loadEmployee(trx, organizationId, employeeId);
    const structure = await structureOn(trx, organizationId, employeeId, run.period_end);
    if (!structure) {
      warnings.push({
        code: 'NO_SALARY_STRUCTURE',
        employeeId,
        message: `${emp.fullName} has no salary structure for this period`,
      });
      continue;
    }
    const later = await trx('salary_structures')
      .where({ organization_id: organizationId, employee_id: employeeId })
      .where('effective_from', '>', run.period_start)
      .where('effective_from', '<=', run.period_end)
      .first('id');
    if (later) {
      warnings.push({
        code: 'MID_PERIOD_REVISION',
        employeeId,
        message: `${emp.fullName}'s salary changed during the period; the structure in force at period end was used`,
      });
    }

    const attendance = await buildMonth(trx, {
      organizationId,
      emp,
      policy: attendancePolicy,
      month,
    });
    const metrics = attendanceMetrics(attendance, settings);
    const policies = await applicablePolicies(trx, {
      organizationId,
      employee: { id: emp.id, branchId: emp.branch.id, departmentId: emp.departmentId },
      periodStart: run.period_start,
      periodEnd: run.period_end,
    });
    const adjustments = (
      await trx('payroll_adjustments').where({
        organization_id: organizationId,
        payroll_run_id: run.id,
        employee_id: employeeId,
      })
    ).map((a) => ({ kind: a.kind, label: a.label, amount: a.amount, reason: a.reason }));

    const empDetails = await trx('employees as e')
      .leftJoin('designations as g', 'g.id', 'e.designation_id')
      .where({ 'e.organization_id': organizationId, 'e.id': employeeId })
      .first('g.name as designation', 'e.joining_date', 'e.exit_date');
    const statutory = await statutoryProvider(trx, {
      organizationId,
      run,
      emp,
      components,
      structure,
      metrics,
    });

    const inputs = {
      components,
      structureAmounts: structure.amounts,
      settings,
      metrics,
      latePenalty: attendance.latePenalty,
      fullDayMinutes: attendancePolicy.full_day_minutes,
      policies,
      adjustments,
      statutoryLines: statutory.lines,
    };
    const result = computePayslip(inputs);
    const snapshot = {
      engineVersion: result.engineVersion,
      period: { start: run.period_start, end: run.period_end },
      employee: {
        id: emp.id,
        employeeNumber: emp.employeeNumber,
        fullName: emp.fullName,
        department: emp.departmentName,
        designation: empDetails.designation,
        branch: emp.branch.name,
        joiningDate: empDetails.joining_date,
        exitDate: empDetails.exit_date,
      },
      structureId: structure.id,
      statutoryRules: statutory.rules,
      inputs,
      result,
    };
    await trx('payroll_items').insert({
      organization_id: organizationId,
      payroll_run_id: run.id,
      employee_id: emp.id,
      gross_earnings: result.grossEarnings,
      total_deductions: result.totalDeductions,
      net_pay: result.netPay,
      calculation_snapshot: snapshot,
    });
    for (const w of result.warnings)
      warnings.push({ ...w, employeeId, message: `${emp.fullName}: ${w.message}` });
    count += 1;
  }

  const today = todayFor('Asia/Kolkata');
  if (run.period_end >= today) {
    warnings.unshift({
      code: 'PERIOD_NOT_ENDED',
      message: 'This period has not ended; attendance may still change',
    });
  }
  return { count, warnings, settings };
}

/** JSON with object keys sorted, so key order (which jsonb normalizes) doesn't affect comparison. */
const canonical = (value) =>
  JSON.stringify(value, (key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );

/** Recomputes an item from its stored inputs and reports whether the result is identical. */
export function verifyItem(item) {
  const snapshot = item.calculation_snapshot;
  const recomputed = computePayslip(snapshot.inputs);
  const same =
    recomputed.grossEarnings === snapshot.result.grossEarnings &&
    recomputed.totalDeductions === snapshot.result.totalDeductions &&
    recomputed.netPay === snapshot.result.netPay &&
    canonical(recomputed.lines) === canonical(snapshot.result.lines) &&
    snapshot.result.netPay === item.net_pay;
  return { reproducible: same, stored: snapshot.result, recomputed };
}

export const periodOf = (month) => ({ start: `${month}-01`, end: monthEnd(month) });
export const previousDay = (date) => addDays(date, -1);
