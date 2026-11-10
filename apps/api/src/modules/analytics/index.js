import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { withTenant } from '../../core/db.js';
import { AppError, forbidden } from '../../core/errors.js';
import { PERMISSIONS } from '../staff-access/permissions.js';
import { addDays, monthEnd } from '../hr-attendance/calc.js';

const P = PERMISSIONS;
const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const n = (v) => Number(v ?? 0);

/**
 * Read-only analytics (Phase 12). Workforce figures need HR access (employees.read + attendance.read);
 * clinic figures need appointments.read. HR roles never see patient data here and clinic roles never
 * see salaries. Branch-scoped users see only their branches.
 */
export function analyticsRouter({ db }) {
  const router = Router();

  router.get('/workforce', async (req, res) => {
    if (
      !req.auth.permissions.has(P.EMPLOYEES_READ) ||
      !req.auth.permissions.has(P.ATTENDANCE_READ)
    ) {
      throw forbidden();
    }
    const { month } = validate(z.object({ month: MONTH }), req.query);
    const from = `${month}-01`;
    const to = monthEnd(month);
    const org = req.auth.organizationId;
    const scope = (q, col) =>
      req.auth.branchIds === null ? q : q.whereIn(col, req.auth.branchIds);
    const out = await withTenant(db, org, async (trx) => {
      const headcount = await scope(trx('employees').where({ organization_id: org }), 'branch_id')
        .groupBy('employment_status')
        .select('employment_status as status', trx.raw('count(*)::int AS n'));
      const joiners = await scope(
        trx('employees').where({ organization_id: org }).whereBetween('joining_date', [from, to]),
        'branch_id',
      )
        .count({ n: '*' })
        .first();
      const exits = await scope(
        trx('employees').where({ organization_id: org }).whereBetween('exit_date', [from, to]),
        'branch_id',
      )
        .count({ n: '*' })
        .first();
      const days = await scope(
        trx('attendance_days')
          .where({ organization_id: org })
          .whereBetween('work_date', [from, to]),
        'branch_id',
      ).first(
        trx.raw("count(*) FILTER (WHERE status = 'present')::int AS present"),
        trx.raw("count(*) FILTER (WHERE status = 'half_day')::int AS half_day"),
        trx.raw("count(*) FILTER (WHERE status = 'reduced_hours')::int AS reduced_hours"),
        trx.raw("count(*) FILTER (WHERE status = 'absent')::int AS absent"),
        trx.raw("count(*) FILTER (WHERE status = 'incomplete')::int AS incomplete"),
        trx.raw('count(*) FILTER (WHERE is_late)::int AS late'),
        trx.raw('coalesce(sum(overtime_minutes), 0)::int AS overtime_minutes'),
        trx.raw('coalesce(sum(worked_minutes), 0)::bigint AS worked_minutes'),
      );
      const byDepartment = await scope(
        trx('attendance_days as a')
          .join('employees as e', 'e.id', 'a.employee_id')
          .leftJoin('departments as d', 'd.id', 'e.department_id')
          .where('a.organization_id', org)
          .whereBetween('a.work_date', [from, to]),
        'a.branch_id',
      )
        .groupBy('d.name')
        .orderBy('present', 'desc')
        .select(
          trx.raw("coalesce(d.name, 'No department') AS department"),
          trx.raw(
            "count(*) FILTER (WHERE a.status IN ('present', 'half_day', 'reduced_hours'))::int AS present",
          ),
          trx.raw('count(*) FILTER (WHERE a.is_late)::int AS late'),
          trx.raw('coalesce(sum(a.overtime_minutes), 0)::int AS overtime_minutes'),
        );
      const lateTop = await scope(
        trx('attendance_days as a')
          .join('employees as e', 'e.id', 'a.employee_id')
          .where({ 'a.organization_id': org, 'a.is_late': true })
          .whereBetween('a.work_date', [from, to]),
        'a.branch_id',
      )
        .groupBy('e.id', 'e.full_name', 'e.employee_number')
        .orderBy('late', 'desc')
        .limit(10)
        .select('e.id', 'e.full_name', 'e.employee_number', trx.raw('count(*)::int AS late'));
      const leave = await scope(
        trx('leave_requests as l')
          .join('leave_types as t', 't.id', 'l.leave_type_id')
          .join('employees as e', 'e.id', 'l.employee_id')
          .where({ 'l.organization_id': org, 'l.status': 'approved' })
          .where('l.start_date', '<=', to)
          .where('l.end_date', '>=', from),
        'e.branch_id',
      )
        .groupBy('t.name')
        .orderBy('days', 'desc')
        .select(
          't.name as type',
          trx.raw('sum(l.days)::float AS days'),
          trx.raw('count(*)::int AS requests'),
        );
      const pendingLeave = await scope(
        trx('leave_requests as l')
          .join('employees as e', 'e.id', 'l.employee_id')
          .where({ 'l.organization_id': org, 'l.status': 'pending' }),
        'e.branch_id',
      )
        .count({ n: '*' })
        .first();
      return {
        month,
        headcount: Object.fromEntries(headcount.map((h) => [h.status, h.n])),
        joiners: n(joiners.n),
        exits: n(exits.n),
        attendance: {
          present: n(days.present),
          halfDay: n(days.half_day),
          reducedHours: n(days.reduced_hours),
          absent: n(days.absent),
          incomplete: n(days.incomplete),
          late: n(days.late),
          overtimeHours: Math.round(n(days.overtime_minutes) / 6) / 10,
          workedHours: Math.round(n(days.worked_minutes) / 6) / 10,
        },
        byDepartment: byDepartment.map((d) => ({
          department: d.department,
          presentDays: d.present,
          late: d.late,
          overtimeHours: Math.round(d.overtime_minutes / 6) / 10,
        })),
        mostLate: lateTop.map((e) => ({
          id: e.id,
          fullName: e.full_name,
          employeeNumber: e.employee_number,
          late: e.late,
        })),
        leaveByType: leave.map((l) => ({ type: l.type, days: l.days, requests: l.requests })),
        pendingLeaveRequests: n(pendingLeave.n),
      };
    });
    res.json(out);
  });

  router.get('/clinic', async (req, res) => {
    if (!req.auth.permissions.has(P.APPOINTMENTS_READ)) throw forbidden();
    const q = validate(z.object({ from: DATE, to: DATE }), req.query);
    if (q.to < q.from || addDays(q.from, 366) < q.to) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Choose a range of up to one year');
    }
    const org = req.auth.organizationId;
    const scope = (x, col) =>
      req.auth.branchIds === null ? x : x.whereIn(col, req.auth.branchIds);
    const out = await withTenant(db, org, async (trx) => {
      const base = () =>
        scope(
          trx('queue_entries as q')
            .where('q.organization_id', org)
            .whereBetween('q.queue_date', [q.from, q.to]),
          'q.branch_id',
        );
      const totals = await base().first(
        trx.raw('count(*)::int AS total'),
        trx.raw("count(*) FILTER (WHERE q.status = 'completed')::int AS completed"),
        trx.raw("count(*) FILTER (WHERE q.status = 'no_show')::int AS no_show"),
        trx.raw("count(*) FILTER (WHERE q.status = 'cancelled')::int AS cancelled"),
        trx.raw("count(*) FILTER (WHERE q.kind = 'walk_in')::int AS walk_ins"),
        trx.raw(
          'avg(extract(epoch FROM (q.called_at - q.checked_in_at)) / 60) FILTER (WHERE q.called_at IS NOT NULL AND q.checked_in_at IS NOT NULL) AS avg_wait',
        ),
        trx.raw(
          'avg(extract(epoch FROM (q.completed_at - q.started_at)) / 60) FILTER (WHERE q.completed_at IS NOT NULL AND q.started_at IS NOT NULL) AS avg_consult',
        ),
      );
      const daily = await base()
        .groupBy('q.queue_date')
        .orderBy('q.queue_date')
        .select(
          'q.queue_date as date',
          trx.raw("count(*) FILTER (WHERE q.status = 'completed')::int AS seen"),
          trx.raw("count(*) FILTER (WHERE q.status = 'no_show')::int AS no_show"),
        );
      const bySource = await base()
        .leftJoin('appointments as a', 'a.id', 'q.appointment_id')
        .groupByRaw('1')
        .select(
          trx.raw("CASE WHEN q.kind = 'walk_in' THEN 'walk_in' ELSE a.source END AS source"),
          trx.raw('count(*)::int AS n'),
        );
      const byDoctor = await base()
        .join('doctors as d', 'd.id', 'q.doctor_id')
        .groupBy('d.id', 'd.display_name')
        .orderBy('seen', 'desc')
        .select(
          'd.display_name as doctor',
          trx.raw("count(*) FILTER (WHERE q.status = 'completed')::int AS seen"),
          trx.raw("count(*) FILTER (WHERE q.status = 'no_show')::int AS no_show"),
          trx.raw(
            'avg(extract(epoch FROM (q.completed_at - q.started_at)) / 60) FILTER (WHERE q.completed_at IS NOT NULL AND q.started_at IS NOT NULL) AS avg_consult',
          ),
        );
      // Arrivals by hour of day in India time (clinics in the pilot are in IST).
      const byHour = await base()
        .whereNotNull('q.checked_in_at')
        .groupByRaw("extract(hour FROM q.checked_in_at AT TIME ZONE 'Asia/Kolkata')")
        .orderByRaw('1')
        .select(
          trx.raw("extract(hour FROM q.checked_in_at AT TIME ZONE 'Asia/Kolkata')::int AS hour"),
          trx.raw('count(*)::int AS n'),
        );
      const newPatients = await trx('patients')
        .where({ organization_id: org })
        .whereRaw("(created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ? AND ?", [q.from, q.to])
        .groupBy('registration_source')
        .select('registration_source as source', trx.raw('count(*)::int AS n'));
      const round = (v) => (v == null ? null : Math.round(Number(v)));
      const finished = n(totals.completed) + n(totals.no_show);
      return {
        from: q.from,
        to: q.to,
        totals: {
          bookings: n(totals.total),
          seen: n(totals.completed),
          noShows: n(totals.no_show),
          cancelled: n(totals.cancelled),
          walkIns: n(totals.walk_ins),
          noShowRate: finished ? Math.round((n(totals.no_show) / finished) * 1000) / 10 : null,
          averageWaitMinutes: round(totals.avg_wait),
          averageConsultationMinutes: round(totals.avg_consult),
        },
        daily: daily.map((d) => ({ date: d.date, seen: d.seen, noShows: d.no_show })),
        bySource: Object.fromEntries(bySource.map((s) => [s.source ?? 'unknown', s.n])),
        byDoctor: byDoctor.map((d) => ({
          doctor: d.doctor,
          seen: d.seen,
          noShows: d.no_show,
          averageConsultationMinutes: round(d.avg_consult),
        })),
        arrivalsByHour: byHour.map((h) => ({ hour: h.hour, arrivals: h.n })),
        newPatients: Object.fromEntries(newPatients.map((p) => [p.source, p.n])),
      };
    });
    res.json(out);
  });

  return router;
}
