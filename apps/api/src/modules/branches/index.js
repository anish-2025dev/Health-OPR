import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { isUuid, withTenant } from '../../core/db.js';
import { conflict, notFound } from '../../core/errors.js';
import { auditContext, recordAudit } from '../audit/index.js';
import { PERMISSIONS, requirePermission } from '../staff-access/permissions.js';

const present = (b) => ({
  id: b.id,
  name: b.name,
  code: b.code,
  address: b.address,
  timezone: b.timezone,
  status: b.status,
  // Geofence for attendance check-in (Phase 9a). Coordinates come back from PostgreSQL as strings.
  location:
    b.latitude === null || b.latitude === undefined
      ? null
      : { latitude: Number(b.latitude), longitude: Number(b.longitude) },
  geofenceRadiusM: b.geofence_radius_m,
  createdAt: b.created_at,
});

const createSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{2,20}$/, 'Use 2-20 letters, digits or dashes'),
    address: z.string().trim().max(500).nullable().optional(),
    timezone: z.string().max(64).default('Asia/Kolkata'),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    address: z.string().trim().max(500).nullable().optional(),
    status: z.enum(['active', 'inactive']).optional(),
    // Set both, or null to clear. Radius in metres (default 10; indoor GPS often needs 30-50).
    location: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      })
      .nullable()
      .optional(),
    geofenceRadiusM: z.number().int().min(5).max(1000).optional(),
  })
  .strict();

function toColumns({ location, geofenceRadiusM, ...rest }) {
  const columns = { ...rest };
  if (location !== undefined) {
    columns.latitude = location?.latitude ?? null;
    columns.longitude = location?.longitude ?? null;
  }
  if (geofenceRadiusM !== undefined) columns.geofence_radius_m = geofenceRadiusM;
  return columns;
}

/** Branch ids the user may see: null = all. */
const scopeToUserBranches = (query, auth, column = 'id') =>
  auth.branchIds === null ? query : query.whereIn(column, auth.branchIds);

export function branchesRouter({ db }) {
  const router = Router();

  router.get('/', requirePermission(PERMISSIONS.BRANCHES_READ), async (req, res) => {
    const rows = await withTenant(db, req.auth.organizationId, (trx) =>
      scopeToUserBranches(
        trx('branches').where({ organization_id: req.auth.organizationId }).orderBy('name'),
        req.auth,
      ),
    );
    res.json({ data: rows.map(present) });
  });

  router.post('/', requirePermission(PERMISSIONS.BRANCHES_MANAGE), async (req, res) => {
    const body = validate(createSchema, req.body);
    const branch = await withTenant(db, req.auth.organizationId, async (trx) => {
      const exists = await trx('branches')
        .where({ organization_id: req.auth.organizationId, code: body.code })
        .first('id');
      if (exists) throw conflict('BRANCH_CODE_TAKEN', 'A branch with this code already exists');
      const [created] = await trx('branches')
        .insert({ organization_id: req.auth.organizationId, ...body })
        .returning('*');
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'branch.created',
        entityType: 'branch',
        entityId: created.id,
        metadata: { code: created.code },
      });
      return created;
    });
    res.status(201).json(present(branch));
  });

  router.patch('/:id', requirePermission(PERMISSIONS.BRANCHES_MANAGE), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Branch not found');
    const body = validate(updateSchema, req.body);
    const branch = await withTenant(db, req.auth.organizationId, async (trx) => {
      const [updated] = await scopeToUserBranches(
        trx('branches').where({ organization_id: req.auth.organizationId, id: req.params.id }),
        req.auth,
      )
        .update({ ...toColumns(body), updated_at: trx.fn.now() })
        .returning('*');
      if (!updated) throw notFound('Branch not found');
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'branch.updated',
        entityType: 'branch',
        entityId: updated.id,
        metadata: { fields: Object.keys(body) },
      });
      return updated;
    });
    res.json(present(branch));
  });

  return router;
}
