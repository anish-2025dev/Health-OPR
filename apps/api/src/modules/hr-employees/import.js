import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { withTenant } from '../../core/db.js';
import { normalizeMobile } from '../../core/phone.js';
import { auditContext, recordAudit } from '../audit/index.js';
import { PERMISSIONS, requirePermission } from '../staff-access/permissions.js';
import { nextEmployeeNumber } from './index.js';

/**
 * Bulk employee upload. The browser turns an Excel (.xlsx) or CSV file into rows of text; this
 * endpoint checks every row and either reports the problems (dryRun, or any error) or imports all
 * rows in one transaction, so a bad file never leaves half the staff added.
 *
 * Columns (headers are matched loosely: case, spaces and underscores are ignored):
 *   full_name*, mobile*, branch* (code or name), joining_date* (DD-MM-YYYY or YYYY-MM-DD),
 *   employee_id, email, department, designation, shift, reports_to (employee ID or mobile, may be in
 *   the same file), employment_type, weekly_off (e.g. "Sun" or "Sat, Sun"),
 *   emergency_contact_name, emergency_contact_phone
 */
export const IMPORT_COLUMNS = [
  'employee_id',
  'full_name',
  'mobile',
  'email',
  'branch',
  'department',
  'designation',
  'shift',
  'reports_to',
  'joining_date',
  'employment_type',
  'weekly_off',
  'emergency_contact_name',
  'emergency_contact_phone',
];
const REQUIRED = ['full_name', 'mobile', 'branch', 'joining_date'];
const MAX_ROWS = 1000;
const DAYS = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};
const TYPES = {
  'full time': 'full_time',
  full_time: 'full_time',
  fulltime: 'full_time',
  'part time': 'part_time',
  part_time: 'part_time',
  parttime: 'part_time',
  contract: 'contract',
  intern: 'intern',
  consultant: 'consultant',
};

const key = (h) =>
  String(h ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '_');
const norm = (v) =>
  String(v ?? '')
    .trim()
    .replace(/\s+/g, ' ');
const lc = (v) => norm(v).toLowerCase();

export function parseDate(v) {
  const t = norm(v);
  let m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  let iso;
  if (m) iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  else if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)))
    iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  else return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

export function parseWeekOff(v) {
  const t = lc(v);
  if (!t) return [0];
  if (['none', 'no', '-'].includes(t)) return [];
  const days = t
    .split(/[,/;&]|\band\b/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => DAYS[x]);
  if (days.some((d) => d === undefined)) return null;
  return [...new Set(days)].sort();
}

const bodySchema = z
  .object({
    rows: z
      .array(z.record(z.string(), z.union([z.string(), z.number(), z.null()])))
      .min(1)
      .max(MAX_ROWS),
    dryRun: z.boolean().default(true),
    createMissing: z.boolean().default(false), // create unknown departments and designations
  })
  .strict();

export function registerImportRoute(router, { db }) {
  router.post('/import', requirePermission(PERMISSIONS.EMPLOYEES_MANAGE), async (req, res) => {
    const body = validate(bodySchema, req.body);
    const org = req.auth.organizationId;
    // Normalise headers.
    const rows = body.rows.map((r) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [key(k), v == null ? '' : String(v)])),
    );
    const unknownHeaders = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter(
      (h) => h && !IMPORT_COLUMNS.includes(h),
    );

    const outcome = await withTenant(db, org, async (trx) => {
      const scope = (q) => (req.auth.branchIds === null ? q : q.whereIn('id', req.auth.branchIds));
      const [branches, departments, designations, shifts, existing] = await Promise.all([
        scope(trx('branches').where({ organization_id: org, status: 'active' })).select(
          'id',
          'name',
          'code',
        ),
        trx('departments').where({ organization_id: org, status: 'active' }).select('id', 'name'),
        trx('designations').where({ organization_id: org, status: 'active' }).select('id', 'name'),
        trx('shifts').where({ organization_id: org, status: 'active' }).select('id', 'name'),
        trx('employees')
          .where({ organization_id: org })
          .select('id', 'employee_number', 'mobile_e164', 'employment_status'),
      ]);
      const byName = (list) => new Map(list.map((x) => [lc(x.name), x.id]));
      const branchBy = new Map([
        ...branches.map((b) => [lc(b.code), b.id]),
        ...branches.map((b) => [lc(b.name), b.id]),
      ]);
      const deptBy = byName(departments);
      const desigBy = byName(designations);
      const shiftBy = byName(shifts);
      const existingByNumber = new Map(existing.map((e) => [lc(e.employee_number), e]));
      const existingByMobile = new Map(existing.map((e) => [e.mobile_e164, e]));

      const fileNumbers = new Map();
      const fileMobiles = new Map();
      const results = rows.map((r, i) => {
        const line = i + 2; // row 1 is the header
        const errors = [];
        for (const f of REQUIRED)
          if (!norm(r[f])) errors.push(`${f.replace('_', ' ')} is required`);
        const fullName = norm(r.full_name);
        if (fullName && (fullName.length < 2 || fullName.length > 200))
          errors.push('full name must be 2–200 characters');
        const mobile = norm(r.mobile) ? normalizeMobile(norm(r.mobile).replace(/\.0$/, '')) : null;
        if (norm(r.mobile) && !mobile)
          errors.push(`mobile "${norm(r.mobile)}" is not a valid mobile number`);
        if (mobile) {
          if (existingByMobile.has(mobile))
            errors.push('mobile is already used by an existing employee');
          if (fileMobiles.has(mobile)) errors.push(`mobile repeats row ${fileMobiles.get(mobile)}`);
          else fileMobiles.set(mobile, line);
        }
        const number = norm(r.employee_id).toUpperCase() || null;
        if (number) {
          if (!/^[A-Z0-9-]{1,20}$/.test(number))
            errors.push('employee ID may have up to 20 letters, digits or dashes');
          if (existingByNumber.has(lc(number))) errors.push(`employee ID ${number} already exists`);
          if (fileNumbers.has(lc(number)))
            errors.push(`employee ID repeats row ${fileNumbers.get(lc(number))}`);
          else fileNumbers.set(lc(number), line);
        }
        const email = norm(r.email).toLowerCase() || null;
        if (email && !z.string().email().safeParse(email).success)
          errors.push(`email "${email}" is not valid`);
        const branchId = norm(r.branch) ? branchBy.get(lc(r.branch)) : null;
        if (norm(r.branch) && !branchId) errors.push(`branch "${norm(r.branch)}" not found`);
        const ref = (value, map, label) => {
          if (!norm(value)) return { id: null };
          const id = map.get(lc(value));
          if (id) return { id };
          if (body.createMissing && label !== 'shift') return { id: null, create: norm(value) };
          errors.push(`${label} "${norm(value)}" not found`);
          return { id: null };
        };
        const department = ref(r.department, deptBy, 'department');
        const designation = ref(r.designation, desigBy, 'designation');
        const shift = ref(r.shift, shiftBy, 'shift');
        const joiningDate = norm(r.joining_date) ? parseDate(r.joining_date) : null;
        if (norm(r.joining_date) && !joiningDate)
          errors.push(`joining date "${norm(r.joining_date)}" — use DD-MM-YYYY`);
        const employmentType = norm(r.employment_type) ? TYPES[lc(r.employment_type)] : 'full_time';
        if (!employmentType)
          errors.push(
            `employment type "${norm(r.employment_type)}" — use full time, part time, contract, intern or consultant`,
          );
        const weeklyOff = parseWeekOff(r.weekly_off);
        if (!weeklyOff)
          errors.push(`weekly off "${norm(r.weekly_off)}" — use day names like Sun or Sat, Sun`);
        const emergencyPhone = norm(r.emergency_contact_phone)
          ? normalizeMobile(norm(r.emergency_contact_phone))
          : null;
        if (norm(r.emergency_contact_phone) && !emergencyPhone)
          errors.push('emergency contact phone is not valid');
        return {
          line,
          errors,
          values: {
            number,
            fullName,
            mobile,
            email,
            branchId,
            department,
            designation,
            shift,
            reportsTo: norm(r.reports_to),
            joiningDate,
            employmentType,
            weeklyOff,
            emergencyName: norm(r.emergency_contact_name) || null,
            emergencyPhone,
          },
        };
      });

      // Reporting managers: an existing employee or someone earlier/later in the same file.
      for (const r of results) {
        const m = r.values.reportsTo;
        if (!m) continue;
        const mob = normalizeMobile(m);
        const existingMgr =
          existingByNumber.get(lc(m)) ?? (mob ? existingByMobile.get(mob) : undefined);
        const fileMgrLine = fileNumbers.get(lc(m)) ?? (mob ? fileMobiles.get(mob) : undefined);
        if (existingMgr) {
          if (existingMgr.employment_status === 'exited')
            r.errors.push(`reports to "${m}" has left`);
          else r.values.managerId = existingMgr.id;
        } else if (fileMgrLine) {
          if (fileMgrLine === r.line) r.errors.push('an employee cannot report to themselves');
          else r.values.managerLine = fileMgrLine;
        } else {
          r.errors.push(`reports to "${m}" — no employee with that ID or mobile`);
        }
      }
      // Reporting loops inside the file (A reports to B, B reports to A).
      const byLine = new Map(results.map((r) => [r.line, r]));
      for (const r of results) {
        const seen = new Set([r.line]);
        let cur = r.values.managerLine;
        while (cur) {
          if (seen.has(cur)) {
            r.errors.push('reporting lines in the file form a loop');
            break;
          }
          seen.add(cur);
          cur = byLine.get(cur)?.values.managerLine;
        }
      }

      const errorCount = results.filter((r) => r.errors.length).length;
      const preview = results.map((r) => ({
        line: r.line,
        fullName: r.values.fullName,
        mobile: r.values.mobile,
        employeeId: r.values.number,
        errors: r.errors,
      }));
      if (body.dryRun || errorCount) return { imported: 0, errorCount, rows: preview };

      // Import: departments/designations to create, then employees, then managers.
      const created = { departments: 0, designations: 0 };
      for (const [field, table, map] of [
        ['department', 'departments', deptBy],
        ['designation', 'designations', desigBy],
      ]) {
        for (const r of results) {
          const want = r.values[field].create;
          if (!want) continue;
          if (!map.has(lc(want))) {
            const [row] = await trx(table)
              .insert({ organization_id: org, name: want })
              .returning('id');
            map.set(lc(want), row.id);
            created[table] += 1;
          }
          r.values[field].id = map.get(lc(want));
        }
      }
      const idByLine = new Map();
      for (const r of results) {
        const v = r.values;
        const [row] = await trx('employees')
          .insert({
            organization_id: org,
            employee_number: v.number ?? (await nextEmployeeNumber(trx, org)),
            full_name: v.fullName,
            mobile_e164: v.mobile,
            email: v.email,
            branch_id: v.branchId,
            department_id: v.department.id,
            designation_id: v.designation.id,
            shift_id: v.shift.id,
            reporting_manager_id: v.managerId ?? null,
            joining_date: v.joiningDate,
            employment_type: v.employmentType,
            weekly_off_days: v.weeklyOff,
            emergency_contact_name: v.emergencyName,
            emergency_contact_phone: v.emergencyPhone,
          })
          .returning('id');
        idByLine.set(r.line, row.id);
      }
      for (const r of results) {
        if (r.values.managerLine) {
          await trx('employees')
            .where({ organization_id: org, id: idByLine.get(r.line) })
            .update({ reporting_manager_id: idByLine.get(r.values.managerLine) });
        }
      }
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'employee.imported',
        entityType: 'employee',
        metadata: { count: results.length, ...created },
      });
      return { imported: results.length, errorCount: 0, created, rows: preview };
    });
    res.status(!body.dryRun && outcome.errorCount ? 400 : 200).json({ ...outcome, unknownHeaders });
  });
}
