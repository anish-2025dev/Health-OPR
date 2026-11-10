import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { isUuid, withTenant } from '../../core/db.js';
import { AppError, conflict, notFound } from '../../core/errors.js';
import { auditContext, recordAudit } from '../audit/index.js';
import { PERMISSIONS, requirePermission } from '../staff-access/permissions.js';

const P = PERMISSIONS;
const UNIQUE_VIOLATION = '23505';

/** Read access for lookup lists (departments, designations, shifts) used by employee forms. */
const requireAnyPermission =
  (...perms) =>
  (req, res, next) => {
    if (perms.some((p) => req.auth.permissions.has(p))) return next();
    next(new AppError(403, 'FORBIDDEN', 'You do not have permission to do this'));
  };
const canReadStructure = requireAnyPermission(P.EMPLOYEES_READ, P.ORG_STRUCTURE_MANAGE);

/**
 * Router for a simple named lookup table (departments, designations) with create/rename/deactivate.
 */
function namedLookupRouter({ db, table, entity, label }) {
  const router = Router();
  const createSchema = z.object({ name: z.string().trim().min(2).max(120) }).strict();
  const updateSchema = z
    .object({
      name: z.string().trim().min(2).max(120).optional(),
      status: z.enum(['active', 'inactive']).optional(),
    })
    .strict();
  const present = (r) => ({ id: r.id, name: r.name, status: r.status, createdAt: r.created_at });
  const duplicate = () => conflict('NAME_TAKEN', `A ${label} with this name already exists`);

  router.get('/', canReadStructure, async (req, res) => {
    const rows = await withTenant(db, req.auth.organizationId, (trx) =>
      trx(table).where({ organization_id: req.auth.organizationId }).orderBy('name'),
    );
    res.json({ data: rows.map(present) });
  });

  router.post('/', requirePermission(P.ORG_STRUCTURE_MANAGE), async (req, res) => {
    const body = validate(createSchema, req.body);
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      let created;
      try {
        [created] = await trx(table)
          .insert({ organization_id: req.auth.organizationId, name: body.name })
          .returning('*');
      } catch (err) {
        if (err.code === UNIQUE_VIOLATION) throw duplicate();
        throw err;
      }
      await recordAudit(trx, {
        ...auditContext(req),
        action: `${entity}.created`,
        entityType: entity,
        entityId: created.id,
      });
      return created;
    });
    res.status(201).json(present(row));
  });

  router.patch('/:id', requirePermission(P.ORG_STRUCTURE_MANAGE), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body = validate(updateSchema, req.body);
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      let updated;
      try {
        [updated] = await trx(table)
          .where({ organization_id: req.auth.organizationId, id: req.params.id })
          .update({ ...body, updated_at: trx.fn.now() })
          .returning('*');
      } catch (err) {
        if (err.code === UNIQUE_VIOLATION) throw duplicate();
        throw err;
      }
      if (!updated) throw notFound();
      await recordAudit(trx, {
        ...auditContext(req),
        action: `${entity}.updated`,
        entityType: entity,
        entityId: updated.id,
        metadata: { fields: Object.keys(body) },
      });
      return updated;
    });
    res.json(present(row));
  });

  return router;
}

// ------------------------------------------------------------------ shifts

const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');
const shiftCreateSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    startTime: TIME,
    endTime: TIME,
    breakMinutes: z.number().int().min(0).max(240).default(0),
  })
  .strict()
  .refine((v) => v.startTime !== v.endTime, {
    path: ['endTime'],
    message: 'End time must differ from start time',
  });
const shiftUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    startTime: TIME.optional(),
    endTime: TIME.optional(),
    breakMinutes: z.number().int().min(0).max(240).optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .strict();

const hhmm = (t) => String(t).slice(0, 5);
const minutes = (t) => Number(hhmm(t).slice(0, 2)) * 60 + Number(hhmm(t).slice(3, 5));

export const presentShift = (s) => {
  const start = minutes(s.start_time);
  const end = minutes(s.end_time);
  const span = end > start ? end - start : 24 * 60 - start + end;
  return {
    id: s.id,
    name: s.name,
    startTime: hhmm(s.start_time),
    endTime: hhmm(s.end_time),
    breakMinutes: s.break_minutes,
    overnight: end < start,
    workMinutes: span - s.break_minutes,
    status: s.status,
  };
};

function shiftsRouter({ db }) {
  const router = Router();

  router.get('/', canReadStructure, async (req, res) => {
    const rows = await withTenant(db, req.auth.organizationId, (trx) =>
      trx('shifts').where({ organization_id: req.auth.organizationId }).orderBy('start_time'),
    );
    res.json({ data: rows.map(presentShift) });
  });

  router.post('/', requirePermission(P.ORG_STRUCTURE_MANAGE), async (req, res) => {
    const body = validate(shiftCreateSchema, req.body);
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      let created;
      try {
        [created] = await trx('shifts')
          .insert({
            organization_id: req.auth.organizationId,
            name: body.name,
            start_time: body.startTime,
            end_time: body.endTime,
            break_minutes: body.breakMinutes,
          })
          .returning('*');
      } catch (err) {
        if (err.code === UNIQUE_VIOLATION)
          throw conflict('NAME_TAKEN', 'A shift with this name already exists');
        throw err;
      }
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'shift.created',
        entityType: 'shift',
        entityId: created.id,
      });
      return created;
    });
    res.status(201).json(presentShift(row));
  });

  router.patch('/:id', requirePermission(P.ORG_STRUCTURE_MANAGE), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body = validate(shiftUpdateSchema, req.body);
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      const changes = { updated_at: trx.fn.now() };
      if (body.name !== undefined) changes.name = body.name;
      if (body.startTime !== undefined) changes.start_time = body.startTime;
      if (body.endTime !== undefined) changes.end_time = body.endTime;
      if (body.breakMinutes !== undefined) changes.break_minutes = body.breakMinutes;
      if (body.status !== undefined) changes.status = body.status;
      let updated;
      try {
        [updated] = await trx('shifts')
          .where({ organization_id: req.auth.organizationId, id: req.params.id })
          .update(changes)
          .returning('*');
      } catch (err) {
        if (err.code === UNIQUE_VIOLATION)
          throw conflict('NAME_TAKEN', 'A shift with this name already exists');
        if (err.code === '23514')
          throw new AppError(400, 'VALIDATION_ERROR', 'End time must differ from start time');
        throw err;
      }
      if (!updated) throw notFound();
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'shift.updated',
        entityType: 'shift',
        entityId: updated.id,
        metadata: { fields: Object.keys(body) },
      });
      return updated;
    });
    res.json(presentShift(row));
  });

  return router;
}

// ------------------------------------------------------------------ holidays

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const holidayCreateSchema = z
  .object({
    date: DATE,
    name: z.string().trim().min(2).max(120),
    branchId: z.string().uuid().nullable().default(null),
    isOptional: z.boolean().default(false),
  })
  .strict();
const holidayListQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  branchId: z.string().uuid().optional(),
});

const presentHoliday = (h) => ({
  id: h.id,
  date: h.holiday_date,
  name: h.name,
  branchId: h.branch_id,
  branchName: h.branch_name ?? null,
  isOptional: h.is_optional,
});

function holidaysRouter({ db }) {
  const router = Router();

  router.get('/', requirePermission(P.HOLIDAYS_READ), async (req, res) => {
    const q = validate(holidayListQuery, req.query);
    const year = q.year ?? new Date().getFullYear();
    const rows = await withTenant(db, req.auth.organizationId, (trx) => {
      const query = trx('holidays as h')
        .leftJoin('branches as b', 'b.id', 'h.branch_id')
        .where('h.organization_id', req.auth.organizationId)
        .whereBetween('h.holiday_date', [`${year}-01-01`, `${year}-12-31`])
        .select('h.*', 'b.name as branch_name')
        .orderBy('h.holiday_date');
      // With a branch filter: that branch's holidays plus organization-wide ones.
      if (q.branchId) {
        query.where((w) => w.whereNull('h.branch_id').orWhere('h.branch_id', q.branchId));
      }
      return query;
    });
    res.json({ data: rows.map(presentHoliday), year });
  });

  router.post('/', requirePermission(P.ORG_STRUCTURE_MANAGE), async (req, res) => {
    const body = validate(holidayCreateSchema, req.body);
    const row = await withTenant(db, req.auth.organizationId, async (trx) => {
      if (body.branchId) {
        const branch = await trx('branches')
          .where({ organization_id: req.auth.organizationId, id: body.branchId })
          .first('id');
        if (!branch) throw new AppError(400, 'VALIDATION_ERROR', 'Unknown branch');
      }
      let created;
      try {
        [created] = await trx('holidays')
          .insert({
            organization_id: req.auth.organizationId,
            branch_id: body.branchId,
            holiday_date: body.date,
            name: body.name,
            is_optional: body.isOptional,
          })
          .returning('*');
      } catch (err) {
        if (err.code === UNIQUE_VIOLATION)
          throw conflict('HOLIDAY_EXISTS', 'A holiday already exists on this date');
        if (err.code === '22008' || err.code === '22007')
          throw new AppError(400, 'VALIDATION_ERROR', 'Invalid date');
        throw err;
      }
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'holiday.created',
        entityType: 'holiday',
        entityId: created.id,
        metadata: { date: body.date },
      });
      return created;
    });
    res.status(201).json(presentHoliday(row));
  });

  router.delete('/:id', requirePermission(P.ORG_STRUCTURE_MANAGE), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    await withTenant(db, req.auth.organizationId, async (trx) => {
      const [deleted] = await trx('holidays')
        .where({ organization_id: req.auth.organizationId, id: req.params.id })
        .delete()
        .returning(['id', 'holiday_date', 'name']);
      if (!deleted) throw notFound();
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'holiday.deleted',
        entityType: 'holiday',
        entityId: deleted.id,
        metadata: { date: deleted.holiday_date, name: deleted.name },
      });
    });
    res.status(204).end();
  });

  return router;
}

export function orgStructureRouters({ db }) {
  return {
    departments: namedLookupRouter({
      db,
      table: 'departments',
      entity: 'department',
      label: 'department',
    }),
    designations: namedLookupRouter({
      db,
      table: 'designations',
      entity: 'designation',
      label: 'designation',
    }),
    shifts: shiftsRouter({ db }),
    holidays: holidaysRouter({ db }),
  };
}
