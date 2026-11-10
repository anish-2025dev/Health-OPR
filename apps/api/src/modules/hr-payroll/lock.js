import { AppError } from '../../core/errors.js';

/** Throws if payroll covering this employee and date has been approved (attendance/leave are frozen). */
/** Throws if approved payroll overlaps any date in [start, end] for this employee. */
export async function assertRangeNotPayrollLocked(trx, organizationId, employeeId, start, end) {
  const locked = await trx('payroll_items as i')
    .join('payroll_runs as r', 'r.id', 'i.payroll_run_id')
    .where({
      'i.organization_id': organizationId,
      'i.employee_id': employeeId,
      'r.status': 'approved',
    })
    .where('r.period_start', '<=', end)
    .where('r.period_end', '>=', start)
    .first('r.id');
  if (locked) {
    throw new AppError(
      409,
      'PAYROLL_LOCKED',
      'Payroll covering these dates has been approved. Record the correction as an adjustment in the next payroll.',
    );
  }
}

export async function assertNotPayrollLocked(trx, organizationId, employeeId, date) {
  const locked = await trx('payroll_items as i')
    .join('payroll_runs as r', 'r.id', 'i.payroll_run_id')
    .where({
      'i.organization_id': organizationId,
      'i.employee_id': employeeId,
      'r.status': 'approved',
    })
    .where('r.period_start', '<=', date)
    .where('r.period_end', '>=', date)
    .first('r.id');
  if (locked) {
    throw new AppError(
      409,
      'PAYROLL_LOCKED',
      'Payroll for this period has been approved. Record the correction as an adjustment in the next payroll.',
    );
  }
}
