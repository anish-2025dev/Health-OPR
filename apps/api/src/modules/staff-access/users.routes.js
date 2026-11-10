import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { isUuid, withTenant } from '../../core/db.js';
import { AppError, conflict, forbidden, notFound } from '../../core/errors.js';
import { auditContext, recordAudit } from '../audit/index.js';
import { generateTemporaryPassword, hashPassword } from '../authentication/passwords.js';
import { canAssignRole, PERMISSIONS, requirePermission, ROLE_KEYS, ROLES } from './permissions.js';

const roleAssignmentSchema = z.object({
  role: z.enum(ROLE_KEYS),
  branchId: z.string().uuid().nullable().default(null),
});

const createSchema = z
  .object({
    fullName: z.string().trim().min(2).max(200),
    email: z.string().trim().toLowerCase().email().max(254),
    phone: z
      .string()
      .trim()
      .regex(/^\+[1-9][0-9]{7,14}$/, 'Use international format, e.g. +919876543210')
      .nullable()
      .optional(),
    roles: z.array(roleAssignmentSchema).min(1).max(20),
  })
  .strict();

const updateSchema = z
  .object({
    fullName: z.string().trim().min(2).max(200).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+[1-9][0-9]{7,14}$/)
      .nullable()
      .optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict();

const setRolesSchema = z.object({ roles: z.array(roleAssignmentSchema).min(1).max(20) }).strict();

const presentUser = (u, assignments) => ({
  id: u.id,
  fullName: u.full_name,
  email: u.email,
  phone: u.phone_e164,
  status: u.status,
  mustChangePassword: u.must_change_password,
  lastLoginAt: u.last_login_at,
  createdAt: u.created_at,
  roles: assignments
    .filter((a) => a.user_id === u.id)
    .map((a) => ({ role: a.role_key, label: ROLES[a.role_key].label, branchId: a.branch_id })),
});

async function assertAssignable(trx, auth, roles) {
  for (const { role } of roles) {
    if (!canAssignRole(auth.roleKeys, role)) {
      throw forbidden(`Only an organization owner can assign the "${ROLES[role].label}" role`);
    }
  }
  const branchIds = [...new Set(roles.map((r) => r.branchId).filter(Boolean))];
  if (branchIds.length) {
    const found = await trx('branches')
      .where({ organization_id: auth.organizationId })
      .whereIn('id', branchIds)
      .pluck('id');
    if (found.length !== branchIds.length) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Unknown branch in role assignment');
    }
  }
}

async function loadUser(trx, auth, id) {
  if (!isUuid(id)) throw notFound('User not found');
  const user = await trx('users').where({ organization_id: auth.organizationId, id }).first();
  if (!user) throw notFound('User not found');
  return user;
}

async function revokeAllSessions(trx, auth, userId, reason) {
  await trx('auth_sessions')
    .where({ organization_id: auth.organizationId, user_id: userId })
    .whereNull('revoked_at')
    .update({ revoked_at: trx.fn.now(), revoke_reason: reason });
}

export function usersRouter({ db }) {
  const router = Router();

  router.get('/roles', requirePermission(PERMISSIONS.USERS_READ), (req, res) => {
    res.json({
      data: ROLE_KEYS.map((key) => ({
        key,
        label: ROLES[key].label,
        permissions: ROLES[key].permissions,
        assignable: canAssignRole(req.auth.roleKeys, key),
      })),
    });
  });

  router.get('/', requirePermission(PERMISSIONS.USERS_READ), async (req, res) => {
    const { users, assignments } = await withTenant(db, req.auth.organizationId, async (trx) => {
      const users = await trx('users')
        .where({ organization_id: req.auth.organizationId })
        .orderBy('full_name');
      const assignments = await trx('user_role_assignments').where({
        organization_id: req.auth.organizationId,
      });
      return { users, assignments };
    });
    res.json({ data: users.map((u) => presentUser(u, assignments)) });
  });

  /** Creates a staff user with a one-time temporary password, returned once to the admin. */
  router.post('/', requirePermission(PERMISSIONS.USERS_MANAGE), async (req, res) => {
    const body = validate(createSchema, req.body);
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    const created = await withTenant(db, req.auth.organizationId, async (trx) => {
      await assertAssignable(trx, req.auth, body.roles);
      let user;
      try {
        [user] = await trx('users')
          .insert({
            organization_id: req.auth.organizationId,
            full_name: body.fullName,
            email: body.email,
            phone_e164: body.phone ?? null,
            password_hash: passwordHash,
            must_change_password: true,
          })
          .returning('*');
      } catch (err) {
        if (err.code === '23505') throw conflict('EMAIL_TAKEN', 'This email is already in use');
        throw err;
      }
      const rows = body.roles.map((r) => ({
        organization_id: req.auth.organizationId,
        user_id: user.id,
        role_key: r.role,
        branch_id: r.branchId,
      }));
      await trx('user_role_assignments').insert(rows).onConflict().ignore();
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'user.created',
        entityType: 'user',
        entityId: user.id,
        metadata: { roles: body.roles },
      });
      const assignments = await trx('user_role_assignments').where({
        organization_id: req.auth.organizationId,
        user_id: user.id,
      });
      return presentUser(user, assignments);
    });

    res.status(201).json({ user: created, temporaryPassword });
  });

  router.patch('/:id', requirePermission(PERMISSIONS.USERS_MANAGE), async (req, res) => {
    const body = validate(updateSchema, req.body);
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const user = await loadUser(trx, req.auth, req.params.id);
      if (body.status === 'disabled' && user.id === req.auth.userId) {
        throw new AppError(400, 'CANNOT_DISABLE_SELF', 'You cannot disable your own account');
      }
      const ownerTarget = await trx('user_role_assignments')
        .where({
          organization_id: req.auth.organizationId,
          user_id: user.id,
          role_key: 'organization_owner',
        })
        .first('id');
      if (ownerTarget && body.status && !req.auth.roleKeys.includes('organization_owner')) {
        throw forbidden('Only an organization owner can change an owner account status');
      }
      const changes = { updated_at: trx.fn.now() };
      if (body.fullName !== undefined) changes.full_name = body.fullName;
      if (body.phone !== undefined) changes.phone_e164 = body.phone;
      if (body.status !== undefined) changes.status = body.status;
      const [updated] = await trx('users')
        .where({ organization_id: req.auth.organizationId, id: user.id })
        .update(changes)
        .returning('*');
      if (body.status === 'disabled')
        await revokeAllSessions(trx, req.auth, user.id, 'user_disabled');
      await recordAudit(trx, {
        ...auditContext(req),
        action: body.status === 'disabled' ? 'user.disabled' : 'user.updated',
        entityType: 'user',
        entityId: user.id,
        metadata: { fields: Object.keys(body) },
      });
      const assignments = await trx('user_role_assignments').where({
        organization_id: req.auth.organizationId,
        user_id: user.id,
      });
      return presentUser(updated, assignments);
    });
    res.json(result);
  });

  router.put('/:id/roles', requirePermission(PERMISSIONS.USERS_MANAGE), async (req, res) => {
    const body = validate(setRolesSchema, req.body);
    const result = await withTenant(db, req.auth.organizationId, async (trx) => {
      const user = await loadUser(trx, req.auth, req.params.id);
      if (user.id === req.auth.userId) {
        throw forbidden('You cannot change your own roles');
      }
      await assertAssignable(trx, req.auth, body.roles);
      const existing = await trx('user_role_assignments').where({
        organization_id: req.auth.organizationId,
        user_id: user.id,
      });
      // Removing an owner role is also owner-only.
      for (const a of existing) {
        const kept = body.roles.some((r) => r.role === a.role_key && r.branchId === a.branch_id);
        if (!kept && !canAssignRole(req.auth.roleKeys, a.role_key)) {
          throw forbidden(
            `Only an organization owner can remove the "${ROLES[a.role_key].label}" role`,
          );
        }
      }
      await trx('user_role_assignments')
        .where({ organization_id: req.auth.organizationId, user_id: user.id })
        .delete();
      await trx('user_role_assignments')
        .insert(
          body.roles.map((r) => ({
            organization_id: req.auth.organizationId,
            user_id: user.id,
            role_key: r.role,
            branch_id: r.branchId,
          })),
        )
        .onConflict()
        .ignore();
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'user.roles_changed',
        entityType: 'user',
        entityId: user.id,
        metadata: {
          before: existing.map((a) => ({ role: a.role_key, branchId: a.branch_id })),
          after: body.roles,
        },
      });
      const assignments = await trx('user_role_assignments').where({
        organization_id: req.auth.organizationId,
        user_id: user.id,
      });
      return presentUser(user, assignments);
    });
    res.json(result);
  });

  router.post(
    '/:id/reset-password',
    requirePermission(PERMISSIONS.USERS_MANAGE),
    async (req, res) => {
      const temporaryPassword = generateTemporaryPassword();
      const passwordHash = await hashPassword(temporaryPassword);
      await withTenant(db, req.auth.organizationId, async (trx) => {
        const user = await loadUser(trx, req.auth, req.params.id);
        if (user.id === req.auth.userId) {
          throw new AppError(
            400,
            'USE_CHANGE_PASSWORD',
            'Use "Change password" for your own account',
          );
        }
        const isOwner = await trx('user_role_assignments')
          .where({
            organization_id: req.auth.organizationId,
            user_id: user.id,
            role_key: 'organization_owner',
          })
          .first('id');
        if (isOwner && !req.auth.roleKeys.includes('organization_owner')) {
          throw forbidden("Only an organization owner can reset an owner's password");
        }
        await trx('users').where({ organization_id: req.auth.organizationId, id: user.id }).update({
          password_hash: passwordHash,
          must_change_password: true,
          failed_login_count: 0,
          locked_until: null,
          updated_at: trx.fn.now(),
        });
        await revokeAllSessions(trx, req.auth, user.id, 'password_reset');
        await recordAudit(trx, {
          ...auditContext(req),
          action: 'user.password_reset',
          entityType: 'user',
          entityId: user.id,
        });
      });
      res.json({ temporaryPassword });
    },
  );

  return router;
}
