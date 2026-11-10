import { AppError, notFound } from '../../core/errors.js';
import { approvedLeaveDays } from '../hr-leave/service.js';
import { assertNotPayrollLocked } from '../hr-payroll/lock.js';
import {
  addDays,
  computeDay,
  dayOfWeek,
  latePenalty,
  localParts,
  minutesToHhmm,
  monthEnd,
  workDateFor,
  zonedToUtc,
} from './calc.js';

// ------------------------------------------------------------------ policy

export async function getPolicy(trx, organizationId) {
  let row = await trx('attendance_policies').where({ organization_id: organizationId }).first();
  if (!row) {
    [row] = await trx('attendance_policies')
      .insert({ organization_id: organizationId })
      .onConflict('organization_id')
      .ignore()
      .returning('*');
    row ??= await trx('attendance_policies').where({ organization_id: organizationId }).first();
  }
  return row;
}

export const presentPolicy = (p) => ({
  fullDayMinutes: p.full_day_minutes,
  halfDayMinutes: p.half_day_minutes,
  belowHalfDayStatus: p.below_half_day_status,
  lateGraceMinutes: p.late_grace_minutes,
  lateFreePerMonth: p.late_free_per_month,
  latePenaltyMode: p.late_penalty_mode,
  latePenaltyAmount: p.late_penalty_amount,
  latePenaltyEveryN: p.late_penalty_every_n,
  overtimeAfterMinutes: p.overtime_after_minutes,
  minPunchGapSeconds: p.min_punch_gap_seconds,
  updatedAt: p.updated_at,
});

// ------------------------------------------------------------------ employee context

export async function loadEmployee(trx, organizationId, employeeId) {
  const e = await trx('employees as e')
    .join('branches as b', 'b.id', 'e.branch_id')
    .leftJoin('shifts as s', 's.id', 'e.shift_id')
    .leftJoin('departments as d', 'd.id', 'e.department_id')
    .leftJoin('employees as m', 'm.id', 'e.reporting_manager_id')
    .where({ 'e.organization_id': organizationId, 'e.id': employeeId })
    .first(
      'e.*',
      'b.name as branch_name',
      'b.timezone as branch_timezone',
      'b.latitude as branch_latitude',
      'b.longitude as branch_longitude',
      'b.geofence_radius_m as branch_radius',
      's.name as shift_name',
      's.start_time as shift_start',
      's.end_time as shift_end',
      's.break_minutes as shift_break',
      'd.name as department_name',
      'm.full_name as manager_name',
    );
  if (!e) return null;
  return {
    id: e.id,
    employeeNumber: e.employee_number,
    fullName: e.full_name,
    mobile: e.mobile_e164,
    status: e.employment_status,
    joiningDate: e.joining_date,
    exitDate: e.exit_date,
    weeklyOffDays: e.weekly_off_days,
    reportingManagerId: e.reporting_manager_id,
    managerName: e.manager_name,
    departmentId: e.department_id,
    departmentName: e.department_name,
    branch: {
      id: e.branch_id,
      name: e.branch_name,
      timeZone: e.branch_timezone,
      location:
        e.branch_latitude === null
          ? null
          : { latitude: Number(e.branch_latitude), longitude: Number(e.branch_longitude) },
      geofenceRadiusM: e.branch_radius,
    },
    shift: e.shift_start
      ? {
          name: e.shift_name,
          start: String(e.shift_start).slice(0, 5),
          end: String(e.shift_end).slice(0, 5),
          breakMinutes: e.shift_break,
        }
      : null,
  };
}

const policySnapshot = (p) => ({
  fullDayMinutes: p.full_day_minutes,
  halfDayMinutes: p.half_day_minutes,
  belowHalfDayStatus: p.below_half_day_status,
  lateGraceMinutes: p.late_grace_minutes,
  overtimeAfterMinutes: p.overtime_after_minutes,
});

async function holidaysFor(trx, organizationId, branchId, from, to) {
  return trx('holidays')
    .where({ organization_id: organizationId, is_optional: false })
    .whereBetween('holiday_date', [from, to])
    .where((w) => w.whereNull('branch_id').orWhere('branch_id', branchId))
    .select('holiday_date', 'name');
}

export const todayFor = (timeZone) => localParts(Date.now(), timeZone).date;

// ------------------------------------------------------------------ day computation

/**
 * Recomputes and stores one work day from its non-voided punches. A manual or regularized status is
 * kept unless `override` provides a new one. Locked days (payroll finalized) can't change.
 */
export async function recomputeDay(trx, { organizationId, emp, workDate, policy, override }) {
  const existing = await trx('attendance_days')
    .where({ organization_id: organizationId, employee_id: emp.id, work_date: workDate })
    .first();
  if (existing?.locked_at) {
    throw new AppError(409, 'DAY_LOCKED', 'This day is locked because payroll has been finalized');
  }
  await assertNotPayrollLocked(trx, organizationId, emp.id, workDate);

  const punches = await trx('attendance_punches')
    .where({ organization_id: organizationId, employee_id: emp.id, work_date: workDate })
    .whereNull('voided_at')
    .orderBy('punched_at');
  const ins = punches.filter((p) => p.punch_type === 'in');
  const outs = punches.filter((p) => p.punch_type === 'out');
  const firstIn = ins[0]?.punched_at ?? null;
  const lastOutCandidate = outs.at(-1)?.punched_at ?? null;
  const lastOut =
    firstIn && lastOutCandidate && new Date(lastOutCandidate) > new Date(firstIn)
      ? lastOutCandidate
      : null;

  const holidays = await holidaysFor(trx, organizationId, emp.branch.id, workDate, workDate);
  const isHoliday = holidays.length > 0;
  const isWeekOff = emp.weeklyOffDays.includes(dayOfWeek(workDate));
  const snapshot = policySnapshot(policy);
  const computed = computeDay({
    policy: snapshot,
    shift: emp.shift,
    workDate,
    firstIn,
    lastOut,
    timeZone: emp.branch.timeZone,
    isHoliday,
    isWeekOff,
    today: todayFor(emp.branch.timeZone),
  });

  let status = computed.status;
  let statusSource = 'computed';
  let manualReason = null;
  let manualBy = null;
  if (override) {
    status = override.status ?? computed.status;
    statusSource = override.source;
    manualReason = override.reason;
    manualBy = override.userId;
  } else if (existing && existing.status_source !== 'computed') {
    status = existing.status;
    statusSource = existing.status_source;
    manualReason = existing.manual_reason;
    manualBy = existing.manual_by_user_id;
  }

  const values = {
    organization_id: organizationId,
    employee_id: emp.id,
    branch_id: emp.branch.id,
    work_date: workDate,
    first_in: firstIn,
    last_out: lastOut,
    shift_start: emp.shift?.start ?? null,
    shift_end: emp.shift?.end ?? null,
    break_minutes: emp.shift?.breakMinutes ?? 0,
    worked_minutes: computed.workedMinutes,
    late_minutes: computed.lateMinutes,
    is_late: computed.isLate,
    overtime_minutes: computed.overtimeMinutes,
    is_holiday: isHoliday,
    is_week_off: isWeekOff,
    status,
    status_source: statusSource,
    manual_reason: manualReason,
    manual_by_user_id: manualBy,
    policy_snapshot: snapshot,
    updated_at: trx.fn.now(),
  };
  const [row] = await trx('attendance_days')
    .insert(values)
    .onConflict(['organization_id', 'employee_id', 'work_date'])
    .merge()
    .returning('*');
  return row;
}

/**
 * Decides whether a punch at `at` is a check-in or a check-out, and for which work date.
 * - The work date comes from the branch-local date, adjusted for overnight shifts.
 * - If that work date already has a check-in, the punch is a check-out (the latest one counts).
 * - Fallback for night work without a shift: an open check-in (no check-out yet) on the previous date
 *   within the last 14 hours receives the check-out.
 */
async function resolvePunchSlot(trx, organizationId, emp, at) {
  const workDate = workDateFor(at, emp.branch.timeZone, emp.shift);
  const current = await trx('attendance_days')
    .where({ organization_id: organizationId, employee_id: emp.id, work_date: workDate })
    .whereNotNull('first_in')
    .first('work_date');
  if (current) return { workDate, punchType: 'out' };
  const previous = await trx('attendance_days')
    .where({
      organization_id: organizationId,
      employee_id: emp.id,
      work_date: addDays(workDate, -1),
    })
    .whereNotNull('first_in')
    .whereNull('last_out')
    .where('first_in', '>', new Date(at.getTime() - 14 * 3600_000))
    .first('work_date');
  if (previous) return { workDate: previous.work_date, punchType: 'out' };
  return { workDate, punchType: 'in' };
}

/** Records an attendance punch (check-in or check-out, see resolvePunchSlot). */
export async function recordPunch(
  trx,
  { organizationId, emp, policy, at, source, distanceM, accuracyM, challengeId, userId, reason },
) {
  const last = await trx('attendance_punches')
    .where({ organization_id: organizationId, employee_id: emp.id })
    .whereNull('voided_at')
    .orderBy('punched_at', 'desc')
    .first('punched_at');
  if (last && at - new Date(last.punched_at) < policy.min_punch_gap_seconds * 1000) {
    throw new AppError(
      409,
      'PUNCH_TOO_SOON',
      'Attendance was just marked. Please wait a minute before marking again.',
    );
  }

  const { workDate, punchType } = await resolvePunchSlot(trx, organizationId, emp, at);
  const [punch] = await trx('attendance_punches')
    .insert({
      organization_id: organizationId,
      employee_id: emp.id,
      branch_id: emp.branch.id,
      work_date: workDate,
      punched_at: at,
      punch_type: punchType,
      source,
      distance_m: distanceM ?? null,
      accuracy_m: accuracyM ?? null,
      otp_challenge_id: challengeId ?? null,
      created_by_user_id: userId ?? null,
      reason: reason ?? null,
    })
    .returning('*');
  const day = await recomputeDay(trx, { organizationId, emp, workDate, policy });
  return { punch, day };
}

/** What the "Mark attendance" button will do now, and today's record if any. */
export async function nextAction(trx, organizationId, emp) {
  const { workDate, punchType } = await resolvePunchSlot(trx, organizationId, emp, new Date());
  const day = await trx('attendance_days')
    .where({ organization_id: organizationId, employee_id: emp.id, work_date: workDate })
    .first();
  return { action: punchType === 'out' ? 'check_out' : 'check_in', workDate, day };
}

/**
 * Manual correction by HR (source 'manual') or an approved regularization (source 'regularization').
 * Times are local 'HH:MM' on the work date; a check-out earlier than the check-in is on the next day.
 * Existing punches of the same type are voided (kept for audit), never deleted.
 */
export async function applyCorrection(
  trx,
  { organizationId, emp, policy, workDate, status, checkIn, checkOut, reason, userId, source },
) {
  const tz = emp.branch.timeZone;
  if (checkIn) {
    await trx('attendance_punches')
      .where({
        organization_id: organizationId,
        employee_id: emp.id,
        work_date: workDate,
        punch_type: 'in',
      })
      .whereNull('voided_at')
      .update({ voided_at: trx.fn.now() });
    await trx('attendance_punches').insert({
      organization_id: organizationId,
      employee_id: emp.id,
      branch_id: emp.branch.id,
      work_date: workDate,
      punched_at: zonedToUtc(workDate, checkIn, tz),
      punch_type: 'in',
      source,
      created_by_user_id: userId,
      reason,
    });
  }
  if (checkOut) {
    const outDate = checkIn && checkOut < checkIn ? addDays(workDate, 1) : workDate;
    await trx('attendance_punches')
      .where({
        organization_id: organizationId,
        employee_id: emp.id,
        work_date: workDate,
        punch_type: 'out',
      })
      .whereNull('voided_at')
      .update({ voided_at: trx.fn.now() });
    await trx('attendance_punches').insert({
      organization_id: organizationId,
      employee_id: emp.id,
      branch_id: emp.branch.id,
      work_date: workDate,
      punched_at: zonedToUtc(outDate, checkOut, tz),
      punch_type: 'out',
      source,
      created_by_user_id: userId,
      reason,
    });
  }
  return recomputeDay(trx, {
    organizationId,
    emp,
    workDate,
    policy,
    override: { status, source, reason, userId },
  });
}

// ------------------------------------------------------------------ views

const localTime = (instant, tz) =>
  instant ? minutesToHhmm(localParts(instant, tz).minutes) : null;

export function presentDay(row, tz) {
  return {
    date: row.work_date,
    status: row.status,
    statusSource: row.status_source,
    manualReason: row.manual_reason,
    checkIn: localTime(row.first_in, tz),
    checkOut: localTime(row.last_out, tz),
    workedMinutes: row.worked_minutes,
    lateMinutes: row.late_minutes,
    isLate: row.is_late,
    overtimeMinutes: row.overtime_minutes,
    isHoliday: row.is_holiday,
    isWeekOff: row.is_week_off,
  };
}

const monthRange = (month) => ({ start: `${month}-01`, end: monthEnd(month) });

/** Full month for one employee: every calendar day, a summary, late entries and holidays. */
export async function buildMonth(trx, { organizationId, emp, policy, month }) {
  const tz = emp.branch.timeZone;
  const { start, end } = monthRange(month);
  const today = todayFor(tz);
  const [rows, holidays, pending, leaveByDate] = await Promise.all([
    trx('attendance_days')
      .where({ organization_id: organizationId, employee_id: emp.id })
      .whereBetween('work_date', [start, end]),
    holidaysFor(trx, organizationId, emp.branch.id, start, end),
    trx('attendance_regularizations')
      .where({ organization_id: organizationId, employee_id: emp.id, status: 'pending' })
      .whereBetween('work_date', [start, end])
      .pluck('work_date'),
    approvedLeaveDays(trx, { organizationId, employee: emp, from: start, to: end }),
  ]);
  const byDate = new Map(rows.map((r) => [r.work_date, r]));
  const holidayByDate = new Map(holidays.map((h) => [h.holiday_date, h.name]));

  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const row = byDate.get(d);
    const isHoliday = holidayByDate.has(d);
    const isWeekOff = emp.weeklyOffDays.includes(dayOfWeek(d));
    let entry;
    if (row) entry = presentDay(row, tz);
    else {
      let status;
      if (d < emp.joiningDate || (emp.exitDate && d > emp.exitDate)) status = 'not_employed';
      else if (isHoliday) status = 'holiday';
      else if (isWeekOff) status = 'week_off';
      else if (d > today) status = 'upcoming';
      else if (d === today) status = 'not_checked_in';
      else status = 'absent';
      entry = {
        date: d,
        status,
        statusSource: 'computed',
        checkIn: null,
        checkOut: null,
        workedMinutes: 0,
        lateMinutes: 0,
        isLate: false,
        overtimeMinutes: 0,
        isHoliday,
        isWeekOff,
      };
    }
    // Approved leave overlays days without attendance (and past absences); a manually edited day or a
    // day the employee actually worked keeps its status, with the leave shown alongside.
    const leave = leaveByDate.get(d) ?? null;
    if (
      leave &&
      entry.statusSource === 'computed' &&
      !entry.checkIn &&
      ['absent', 'incomplete', 'not_checked_in', 'upcoming'].includes(entry.status)
    ) {
      entry = { ...entry, status: 'leave' };
    }
    days.push({
      ...entry,
      leave,
      dayOfWeek: dayOfWeek(d),
      holidayName: holidayByDate.get(d) ?? null,
      pendingRegularization: pending.includes(d),
    });
  }

  const count = (s) => days.filter((d) => d.status === s).length;
  const lateEntries = days
    .filter((d) => d.isLate)
    .map((d) => ({ date: d.date, checkIn: d.checkIn, lateMinutes: d.lateMinutes }));
  const policyView = presentPolicy(policy);
  return {
    month,
    today,
    employee: {
      id: emp.id,
      employeeNumber: emp.employeeNumber,
      fullName: emp.fullName,
      branch: { id: emp.branch.id, name: emp.branch.name },
      department: emp.departmentName,
      shift: emp.shift,
    },
    days,
    summary: {
      present: count('present'),
      halfDay: count('half_day'),
      reducedHours: count('reduced_hours'),
      absent: count('absent'),
      incomplete: count('incomplete'),
      leave: count('leave'),
      leaveDays: days.reduce((a, d) => a + (d.leave ? d.leave.fraction : 0), 0),
      paidLeaveDays: days.reduce((a, d) => a + (d.leave?.isPaid ? d.leave.fraction : 0), 0),
      unpaidLeaveDays: days.reduce(
        (a, d) => a + (d.leave && !d.leave.isPaid ? d.leave.fraction : 0),
        0,
      ),
      weekOff: count('week_off'),
      holiday: count('holiday'),
      late: lateEntries.length,
      workedMinutes: days.reduce((a, d) => a + d.workedMinutes, 0),
      overtimeMinutes: days.reduce((a, d) => a + d.overtimeMinutes, 0),
    },
    lateEntries,
    latePenalty: latePenalty(
      {
        lateFreePerMonth: policyView.lateFreePerMonth,
        latePenaltyMode: policyView.latePenaltyMode,
        latePenaltyAmount: policyView.latePenaltyAmount,
        latePenaltyEveryN: policyView.latePenaltyEveryN,
      },
      lateEntries.length,
    ),
    holidays: holidays.map((h) => ({ date: h.holiday_date, name: h.name })),
    policy: policyView,
  };
}

/** Daily register: one entry per employee in scope for a date. */
export async function buildRegister(trx, { auth, date, branchId, departmentId }) {
  const organizationId = auth.organizationId;
  const query = trx('employees as e')
    .join('branches as b', 'b.id', 'e.branch_id')
    .leftJoin('departments as d', 'd.id', 'e.department_id')
    .leftJoin('employees as m', 'm.id', 'e.reporting_manager_id')
    .where('e.organization_id', organizationId)
    .whereIn('e.employment_status', ['active', 'on_notice'])
    .where('e.joining_date', '<=', date)
    .select(
      'e.id',
      'e.employee_number',
      'e.full_name',
      'e.branch_id',
      'e.weekly_off_days',
      'b.name as branch_name',
      'b.timezone',
      'd.id as department_id',
      'd.name as department_name',
      'm.full_name as manager_name',
    )
    .orderBy('e.full_name');
  if (auth.branchIds !== null) query.whereIn('e.branch_id', auth.branchIds);
  if (branchId) query.where('e.branch_id', branchId);
  if (departmentId) query.where('e.department_id', departmentId);
  const employees = await query;

  const ids = employees.map((e) => e.id);
  const [rows, holidays, onLeave] = await Promise.all([
    ids.length
      ? trx('attendance_days')
          .where({ organization_id: organizationId, work_date: date })
          .whereIn('employee_id', ids)
      : [],
    trx('holidays')
      .where({ organization_id: organizationId, holiday_date: date, is_optional: false })
      .select('branch_id', 'name'),
    ids.length
      ? trx('leave_requests as r')
          .join('leave_types as t', 't.id', 'r.leave_type_id')
          .where({ 'r.organization_id': organizationId, 'r.status': 'approved' })
          .whereIn('r.employee_id', ids)
          .where('r.start_date', '<=', date)
          .where('r.end_date', '>=', date)
          .select(
            'r.employee_id',
            't.name as type_name',
            'r.start_date',
            'r.end_date',
            'r.start_half',
            'r.end_half',
          )
      : [],
  ]);
  const byEmployee = new Map(rows.map((r) => [r.employee_id, r]));
  const leaveByEmployee = new Map(onLeave.map((l) => [l.employee_id, l]));

  return employees.map((e) => {
    const row = byEmployee.get(e.id);
    const holiday = holidays.find((h) => h.branch_id === null || h.branch_id === e.branch_id);
    const today = todayFor(e.timezone);
    let day;
    if (row) day = presentDay(row, e.timezone);
    else {
      const isWeekOff = e.weekly_off_days.includes(dayOfWeek(date));
      const status = holiday
        ? 'holiday'
        : isWeekOff
          ? 'week_off'
          : date === today
            ? 'not_checked_in'
            : date > today
              ? 'upcoming'
              : 'absent';
      day = {
        date,
        status,
        checkIn: null,
        checkOut: null,
        workedMinutes: 0,
        lateMinutes: 0,
        isLate: false,
        overtimeMinutes: 0,
      };
    }
    const leave = leaveByEmployee.get(e.id);
    const isOff = day.status === 'holiday' || day.status === 'week_off';
    if (
      leave &&
      !isOff &&
      !day.checkIn &&
      ['absent', 'not_checked_in', 'upcoming', 'incomplete'].includes(day.status)
    ) {
      const half =
        (leave.start_half && leave.start_date === date) ||
        (leave.end_half && leave.end_date === date);
      day = {
        ...day,
        status: 'leave',
        leave: { typeName: leave.type_name, fraction: half ? 0.5 : 1 },
      };
    }
    return {
      employee: {
        id: e.id,
        employeeNumber: e.employee_number,
        fullName: e.full_name,
        branch: { id: e.branch_id, name: e.branch_name },
        department: e.department_id ? { id: e.department_id, name: e.department_name } : null,
        managerName: e.manager_name,
      },
      day,
    };
  });
}

export function summarizeRegister(entries) {
  const totals = {
    employees: entries.length,
    checkedIn: 0,
    late: 0,
    absent: 0,
    notCheckedIn: 0,
    weekOff: 0,
    holiday: 0,
    leave: 0,
  };
  const byDepartment = new Map();
  for (const { employee, day } of entries) {
    const present = Boolean(day.checkIn);
    if (present) totals.checkedIn += 1;
    if (day.isLate) totals.late += 1;
    if (day.status === 'absent') totals.absent += 1;
    if (day.status === 'not_checked_in') totals.notCheckedIn += 1;
    if (day.status === 'week_off') totals.weekOff += 1;
    if (day.status === 'holiday') totals.holiday += 1;
    if (day.status === 'leave') totals.leave += 1;
    const key = employee.department?.name ?? 'No department';
    const dep = byDepartment.get(key) ?? { department: key, total: 0, checkedIn: 0 };
    dep.total += 1;
    if (present) dep.checkedIn += 1;
    byDepartment.set(key, dep);
  }
  return {
    totals,
    byDepartment: [...byDepartment.values()].sort((a, b) =>
      a.department.localeCompare(b.department),
    ),
  };
}

export function assertEmployeeFound(emp) {
  if (!emp) throw notFound('Employee not found');
  return emp;
}
