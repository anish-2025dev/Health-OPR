import { AppError, conflict } from '../../core/errors.js';
import { localParts } from '../hr-attendance/calc.js';
import { accruedDays, countLeaveDays, leaveYearOf, leaveYearRange } from './calc.js';

export const presentType = (t) => ({
  id: t.id,
  name: t.name,
  code: t.code,
  isPaid: t.is_paid,
  annualQuota: Number(t.annual_quota),
  accrual: t.accrual,
  carryForwardMax: Number(t.carry_forward_max),
  allowHalfDay: t.allow_half_day,
  minNoticeDays: t.min_notice_days,
  maxConsecutiveDays: t.max_consecutive_days,
  approvalLevels: t.approval_levels,
  status: t.status,
});

export async function leaveSettings(trx, organizationId) {
  const org = await trx('organizations')
    .where({ id: organizationId })
    .first('leave_year_start_month', 'timezone');
  return { startMonth: org.leave_year_start_month, timeZone: org.timezone };
}

export const todayIn = (timeZone) => localParts(Date.now(), timeZone).date;

/** Non-optional holidays for an employee's branch between two dates, as a Set of 'YYYY-MM-DD'. */
export async function holidaySet(trx, organizationId, branchId, from, to) {
  const rows = await trx('holidays')
    .where({ organization_id: organizationId, is_optional: false })
    .whereBetween('holiday_date', [from, to])
    .where((w) => w.whereNull('branch_id').orWhere('branch_id', branchId))
    .pluck('holiday_date');
  return new Set(rows);
}

async function employeeRow(trx, organizationId, employeeId) {
  return trx('employees')
    .where({ organization_id: organizationId, id: employeeId })
    .first(
      'id',
      'full_name',
      'employee_number',
      'branch_id',
      'reporting_manager_id',
      'weekly_off_days',
      'joining_date',
      'exit_date',
      'employment_status',
    );
}

/**
 * Balances for one employee for a leave year:
 * available = accrued + adjustments − approved − pending.
 */
export async function balancesFor(
  trx,
  { organizationId, employee, year, settings, excludeRequestId = null },
) {
  const [types, adjustments, used] = await Promise.all([
    trx('leave_types').where({ organization_id: organizationId }).orderBy('name'),
    trx('leave_balance_adjustments')
      .where({ organization_id: organizationId, employee_id: employee.id, leave_year: year })
      .groupBy('leave_type_id')
      .select('leave_type_id')
      .sum({ days: 'days' }),
    trx('leave_requests')
      .where({ organization_id: organizationId, employee_id: employee.id, leave_year: year })
      .whereIn('status', ['approved', 'pending'])
      .modify((q) => excludeRequestId && q.whereNot('id', excludeRequestId))
      .groupBy('leave_type_id', 'status')
      .select('leave_type_id', 'status')
      .sum({ days: 'days' }),
  ]);
  const asOf = todayIn(settings.timeZone);
  return types
    .filter((t) => t.status === 'active' || used.some((u) => u.leave_type_id === t.id))
    .map((t) => {
      const accrued = accruedDays({
        type: t,
        year,
        startMonth: settings.startMonth,
        joiningDate: employee.joining_date,
        asOf,
      });
      const adjusted = Number(adjustments.find((a) => a.leave_type_id === t.id)?.days ?? 0);
      const approved = Number(
        used.find((u) => u.leave_type_id === t.id && u.status === 'approved')?.days ?? 0,
      );
      const pending = Number(
        used.find((u) => u.leave_type_id === t.id && u.status === 'pending')?.days ?? 0,
      );
      const unlimited = !t.is_paid && Number(t.annual_quota) === 0;
      return {
        type: presentType(t),
        accrued,
        adjusted,
        used: approved,
        pending,
        available: unlimited ? null : accrued + adjusted - approved - pending,
      };
    });
}

/** Validates an application and returns the computed day count. Throws AppError on any rule. */
export async function validateApplication(
  trx,
  { organizationId, employee, type, body, settings, requestId = null },
) {
  if (type.status !== 'active')
    throw new AppError(400, 'VALIDATION_ERROR', 'This leave type is not active');
  if (!type.allow_half_day && (body.startHalf || body.endHalf)) {
    throw new AppError(400, 'VALIDATION_ERROR', `${type.name} cannot be taken as half days`);
  }
  if (body.endDate < body.startDate)
    throw new AppError(400, 'VALIDATION_ERROR', 'End date is before start date');
  if (body.startDate < employee.joining_date) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Leave cannot start before the joining date');
  }
  const year = leaveYearOf(body.startDate, settings.startMonth);
  if (leaveYearOf(body.endDate, settings.startMonth) !== year) {
    const { end } = leaveYearRange(year, settings.startMonth);
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `A leave cannot cross the leave year end (${end}); split it into two requests`,
    );
  }

  const today = todayIn(settings.timeZone);
  if (type.min_notice_days > 0) {
    const noticeDays = Math.round((Date.parse(body.startDate) - Date.parse(today)) / 86_400_000);
    if (noticeDays < type.min_notice_days) {
      throw new AppError(
        400,
        'NOTICE_TOO_SHORT',
        `${type.name} needs at least ${type.min_notice_days} day(s) notice`,
      );
    }
  }

  const holidays = await holidaySet(
    trx,
    organizationId,
    employee.branch_id,
    body.startDate,
    body.endDate,
  );
  const { days } = countLeaveDays({
    start: body.startDate,
    end: body.endDate,
    startHalf: Boolean(body.startHalf),
    endHalf: Boolean(body.endHalf),
    weeklyOffDays: employee.weekly_off_days,
    holidays,
  });
  if (days <= 0)
    throw new AppError(400, 'NO_WORKING_DAYS', 'The selected dates are all week offs or holidays');
  if (type.max_consecutive_days && days > type.max_consecutive_days) {
    throw new AppError(
      400,
      'TOO_MANY_DAYS',
      `${type.name} allows at most ${type.max_consecutive_days} day(s) at a time`,
    );
  }

  const overlap = await trx('leave_requests')
    .where({ organization_id: organizationId, employee_id: employee.id })
    .whereIn('status', ['pending', 'approved'])
    .where('start_date', '<=', body.endDate)
    .where('end_date', '>=', body.startDate)
    .modify((q) => requestId && q.whereNot('id', requestId))
    .first('id');
  if (overlap) throw conflict('LEAVE_OVERLAP', 'You already have leave on some of these dates');

  const balances = await balancesFor(trx, {
    organizationId,
    employee,
    year,
    settings,
    excludeRequestId: requestId,
  });
  const balance = balances.find((b) => b.type.id === type.id);
  if (balance && balance.available !== null && days > balance.available) {
    throw new AppError(
      400,
      'INSUFFICIENT_BALANCE',
      `Not enough ${type.name} balance: ${balance.available} day(s) available, ${days} requested. Choose an unpaid leave type for the rest.`,
    );
  }
  return {
    days,
    year,
    balanceAfter: balance?.available === null || !balance ? null : balance.available - days,
  };
}

export const lockEmployee = (trx, organizationId, employeeId) =>
  trx('employees')
    .where({ organization_id: organizationId, id: employeeId })
    .forUpdate()
    .first('id');

export { employeeRow };

/**
 * Approved leave per date for attendance views:
 * Map<'YYYY-MM-DD', { typeName, code, isPaid, fraction }>.
 */
export async function approvedLeaveDays(trx, { organizationId, employee, from, to }) {
  const requests = await trx('leave_requests as r')
    .join('leave_types as t', 't.id', 'r.leave_type_id')
    .where({
      'r.organization_id': organizationId,
      'r.employee_id': employee.id,
      'r.status': 'approved',
    })
    .where('r.start_date', '<=', to)
    .where('r.end_date', '>=', from)
    .select('r.*', 't.name as type_name', 't.code as type_code', 't.is_paid');
  const map = new Map();
  if (!requests.length) return map;
  const holidays = await holidaySet(
    trx,
    organizationId,
    employee.branch_id ?? employee.branch?.id,
    from,
    to,
  );
  for (const r of requests) {
    const { dates } = countLeaveDays({
      start: r.start_date,
      end: r.end_date,
      startHalf: r.start_half,
      endHalf: r.end_half,
      weeklyOffDays: employee.weekly_off_days ?? employee.weeklyOffDays,
      holidays,
    });
    for (const { date, fraction } of dates) {
      if (date < from || date > to) continue;
      map.set(date, { typeName: r.type_name, code: r.type_code, isPaid: r.is_paid, fraction });
    }
  }
  return map;
}
