import { Router } from 'express';
import { isUuid, withTenant } from '../../core/db.js';
import { notFound, forbidden } from '../../core/errors.js';
import { recordAudit } from '../audit/index.js';
import { PERMISSIONS, requirePermission } from '../staff-access/permissions.js';

const P = PERMISSIONS;

export function hrDeviceRouter({ db }) {
  const router = Router();

  // HR view employee device
  router.get('/:id/device', requirePermission(P.EMPLOYEES_READ), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Employee not found');
    const orgId = req.auth.organizationId;

    const device = await withTenant(db, orgId, async (trx) => {
      const emp = await trx('employees')
        .where({ organization_id: orgId, id: req.params.id })
        .first('id', 'branch_id', 'full_name');
      if (!emp) throw notFound('Employee not found');
      if (req.auth.branchIds !== null && !req.auth.branchIds.includes(emp.branch_id)) {
        throw forbidden();
      }

      const active = await trx('employee_device_registrations')
        .where({ organization_id: orgId, employee_id: emp.id, is_active: true })
        .first();

      return active
        ? {
            id: active.id,
            employeeId: active.employee_id,
            deviceFingerprint: active.device_fingerprint,
            deviceLabel: active.device_label,
            registeredAt: active.registered_at,
            lastSeenAt: active.last_seen_at,
            isActive: active.is_active,
          }
        : null;
    });

    res.json({ device });
  });

  // HR reset employee device (§3.2)
  router.post('/:id/reset-device', requirePermission(P.EMPLOYEES_MANAGE), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Employee not found');
    const orgId = req.auth.organizationId;

    const result = await withTenant(db, orgId, async (trx) => {
      const emp = await trx('employees')
        .where({ organization_id: orgId, id: req.params.id })
        .first('id', 'branch_id', 'full_name');
      if (!emp) throw notFound('Employee not found');
      if (req.auth.branchIds !== null && !req.auth.branchIds.includes(emp.branch_id)) {
        throw forbidden();
      }

      const deactivatedCount = await trx('employee_device_registrations')
        .where({ organization_id: orgId, employee_id: emp.id, is_active: true })
        .update({ is_active: false, updated_at: trx.fn.now() });

      await recordAudit(trx, {
        organizationId: orgId,
        actorUserId: req.auth.userId,
        action: 'device.reset',
        entityType: 'employee',
        entityId: emp.id,
        metadata: { deactivatedDevices: deactivatedCount },
      });

      return { reset: true, deactivatedDevices: deactivatedCount };
    });

    res.json(result);
  });

  return router;
}

export function selfDeviceRouter({ db }) {
  const router = Router();

  const requireEmployee = (req) => {
    if (!req.auth.employee) throw notFound('No employee profile linked to this login');
    return req.auth.employee.id;
  };

  router.get('/', async (req, res) => {
    const me = requireEmployee(req);
    const orgId = req.auth.organizationId;

    const device = await withTenant(db, orgId, async (trx) => {
      const active = await trx('employee_device_registrations')
        .where({ organization_id: orgId, employee_id: me, is_active: true })
        .first();

      return active
        ? {
            id: active.id,
            deviceLabel: active.device_label,
            registeredAt: active.registered_at,
            lastSeenAt: active.last_seen_at,
          }
        : null;
    });

    res.json({ registeredDevice: device });
  });

  return router;
}
