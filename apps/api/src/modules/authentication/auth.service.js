import { randomUUID } from 'node:crypto';
import { AppError, unauthorized } from '../../core/errors.js';
import { withSystem, withTenant } from '../../core/db.js';
import { recordAudit } from '../audit/index.js';
import { permissionsFor } from '../staff-access/permissions.js';
import { dummyHash, hashPassword, verifyPassword } from './passwords.js';
import { hashToken, newRefreshToken } from './tokens.js';

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;
/** A refresh token reused within this window is treated as a parallel-tab race, not theft. */
const REFRESH_RACE_GRACE_MS = 10_000;

const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
const invalidSession = () =>
  new AppError(401, 'INVALID_SESSION', 'Your session has ended. Please sign in again.');

/**
 * Authentication service.
 *
 * "System" lookups (find a user by email, find a session by refresh-token hash) run in withSystem()
 * because the tenant is not known yet. Everything after that runs inside withTenant(), so RLS applies.
 */
export function createAuthService({ db, config, tokens }) {
  const refreshTtlMs = config.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60 * 1000;

  async function issueSession(trx, { user, familyId, meta }) {
    const refreshToken = newRefreshToken();
    const [session] = await trx('auth_sessions')
      .insert({
        organization_id: user.organization_id,
        user_id: user.id,
        family_id: familyId,
        token_hash: hashToken(refreshToken),
        expires_at: new Date(Date.now() + refreshTtlMs),
        user_agent: meta.userAgent?.slice(0, 300) ?? null,
        ip: meta.ip ?? null,
      })
      .returning(['id']);
    const accessToken = await tokens.signAccessToken({
      userId: user.id,
      organizationId: user.organization_id,
      sessionId: session.id,
    });
    return { accessToken, refreshToken, expiresIn: tokens.ttlSeconds };
  }

  async function revokeFamily(organizationId, familyId, reason) {
    await withTenant(db, organizationId, (trx) =>
      trx('auth_sessions')
        .where({ organization_id: organizationId, family_id: familyId })
        .whereNull('revoked_at')
        .update({ revoked_at: trx.fn.now(), revoke_reason: reason }),
    );
  }

  return {
    /** Starts a new session family for an already-verified user (used by employee OTP sign-in). */
    startSession: (trx, user, meta) => issueSession(trx, { user, familyId: randomUUID(), meta }),

    async login({ email, password, meta }) {
      // System context: the tenant is not known until we find the user.
      const user = await withSystem(db, (trx) =>
        trx('users as u')
          .join('organizations as o', 'o.id', 'u.organization_id')
          .whereRaw('lower(u.email) = lower(?)', [email])
          .first('u.*', 'o.status as organization_status'),
      );

      if (!user) {
        await verifyPassword(await dummyHash(), password); // equalize timing
        throw invalidCredentials();
      }

      const orgId = user.organization_id;
      const auditBase = {
        organizationId: orgId,
        actorUserId: user.id,
        ip: meta.ip,
        requestId: meta.requestId,
      };

      if (user.locked_until && new Date(user.locked_until) > new Date()) {
        throw new AppError(
          423,
          'ACCOUNT_LOCKED',
          'Too many failed attempts. Try again later or ask an admin to reset your password.',
        );
      }

      const ok = await verifyPassword(user.password_hash, password);
      if (!ok) {
        await withTenant(db, orgId, async (trx) => {
          const failed = user.failed_login_count + 1;
          await trx('users')
            .where({ organization_id: orgId, id: user.id })
            .update({
              failed_login_count: failed,
              locked_until:
                failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
            });
          await recordAudit(trx, {
            ...auditBase,
            action: failed >= MAX_FAILED_LOGINS ? 'auth.account_locked' : 'auth.login_failed',
            entityType: 'user',
            entityId: user.id,
          });
        });
        throw invalidCredentials();
      }

      if (user.status !== 'active' || user.organization_status !== 'active') {
        throw new AppError(
          403,
          'ACCOUNT_DISABLED',
          'This account is not active. Contact your admin.',
        );
      }

      return withTenant(db, orgId, async (trx) => {
        await trx('users')
          .where({ organization_id: orgId, id: user.id })
          .update({ failed_login_count: 0, locked_until: null, last_login_at: trx.fn.now() });
        await recordAudit(trx, {
          ...auditBase,
          action: 'auth.login',
          entityType: 'user',
          entityId: user.id,
        });
        return issueSession(trx, { user, familyId: randomUUID(), meta });
      });
    },

    async refresh({ refreshToken, meta }) {
      if (!refreshToken) throw invalidSession();
      // System context: the refresh token is the only thing identifying the tenant.
      const session = await withSystem(db, (trx) =>
        trx('auth_sessions as s')
          .join('users as u', 'u.id', 's.user_id')
          .join('organizations as o', 'o.id', 's.organization_id')
          .where('s.token_hash', hashToken(refreshToken))
          .first('s.*', 'u.status as user_status', 'o.status as organization_status'),
      );
      if (!session) throw invalidSession();

      const orgId = session.organization_id;
      if (session.revoked_at) throw invalidSession();
      if (session.rotated_at) {
        const sinceRotation = Date.now() - new Date(session.rotated_at).getTime();
        if (sinceRotation <= REFRESH_RACE_GRACE_MS) {
          throw new AppError(401, 'REFRESH_RACE', 'Session was just refreshed. Retry.');
        }
        // An old refresh token was replayed: assume it was stolen and end the whole session family.
        await revokeFamily(orgId, session.family_id, 'refresh_token_reuse');
        await withTenant(db, orgId, (trx) =>
          recordAudit(trx, {
            organizationId: orgId,
            actorUserId: session.user_id,
            action: 'auth.refresh_reuse_detected',
            entityType: 'user',
            entityId: session.user_id,
            ip: meta.ip,
            requestId: meta.requestId,
          }),
        );
        throw invalidSession();
      }
      if (new Date(session.expires_at) <= new Date()) throw invalidSession();
      if (session.user_status !== 'active' || session.organization_status !== 'active') {
        await revokeFamily(orgId, session.family_id, 'account_inactive');
        throw invalidSession();
      }

      return withTenant(db, orgId, async (trx) => {
        const rotated = await trx('auth_sessions')
          .where({ organization_id: orgId, id: session.id })
          .whereNull('rotated_at')
          .whereNull('revoked_at')
          .update({ rotated_at: trx.fn.now() })
          .returning('id');
        if (rotated.length === 0) {
          throw new AppError(401, 'REFRESH_RACE', 'Session was just refreshed. Retry.');
        }
        return issueSession(trx, {
          user: { id: session.user_id, organization_id: orgId },
          familyId: session.family_id,
          meta,
        });
      });
    },

    async logout({ refreshToken, meta }) {
      if (!refreshToken) return;
      const session = await withSystem(db, (trx) =>
        trx('auth_sessions').where('token_hash', hashToken(refreshToken)).first(),
      );
      if (!session) return;
      await revokeFamily(session.organization_id, session.family_id, 'logout');
      await withTenant(db, session.organization_id, (trx) =>
        recordAudit(trx, {
          organizationId: session.organization_id,
          actorUserId: session.user_id,
          action: 'auth.logout',
          entityType: 'user',
          entityId: session.user_id,
          ip: meta.ip,
          requestId: meta.requestId,
        }),
      );
    },

    /** Loads everything authorization needs for one request, or throws 401. */
    async loadAuthContext({ userId, organizationId, sessionId }) {
      return withTenant(db, organizationId, async (trx) => {
        const row = await trx('users as u')
          .join('organizations as o', 'o.id', 'u.organization_id')
          .join('auth_sessions as s', 's.user_id', 'u.id')
          .where({ 'u.organization_id': organizationId, 'u.id': userId, 's.id': sessionId })
          .first(
            'u.id',
            'u.email',
            'u.full_name',
            'u.status',
            'u.must_change_password',
            'o.name as organization_name',
            'o.slug as organization_slug',
            'o.timezone as organization_timezone',
            'o.status as organization_status',
            's.revoked_at',
          );
        if (
          !row ||
          row.revoked_at ||
          row.status !== 'active' ||
          row.organization_status !== 'active'
        ) {
          throw unauthorized();
        }
        const assignments = await trx('user_role_assignments')
          .where({ organization_id: organizationId, user_id: userId })
          .select('role_key', 'branch_id');
        const roleKeys = [...new Set(assignments.map((a) => a.role_key))];
        // Employee profile linked to this login (staff can also be employees).
        const employee = await trx('employees')
          .where({ organization_id: organizationId, user_id: userId })
          .first('id', 'employee_number', 'full_name', 'branch_id', 'employment_status');
        const directReports = employee
          ? await trx('employees')
              .where({ organization_id: organizationId, reporting_manager_id: employee.id })
              .whereIn('employment_status', ['active', 'on_notice'])
              .count({ n: '*' })
              .first()
          : { n: 0 };
        const employeeOnly = roleKeys.length > 0 && roleKeys.every((r) => r === 'employee');
        if (
          employeeOnly &&
          (!employee || !['active', 'on_notice'].includes(employee.employment_status))
        ) {
          throw unauthorized();
        }
        const allBranches = assignments.some((a) => a.branch_id === null);
        return {
          userId,
          organizationId,
          sessionId,
          email: row.email,
          fullName: row.full_name,
          mustChangePassword: row.must_change_password,
          organization: {
            id: organizationId,
            name: row.organization_name,
            slug: row.organization_slug,
            timezone: row.organization_timezone,
          },
          roles: assignments.map((a) => ({ role: a.role_key, branchId: a.branch_id })),
          roleKeys,
          permissions: permissionsFor(roleKeys),
          // null = all branches; otherwise only these branch ids.
          branchIds: allBranches ? null : [...new Set(assignments.map((a) => a.branch_id))],
          employee: employee
            ? {
                id: employee.id,
                employeeNumber: employee.employee_number,
                fullName: employee.full_name,
                branchId: employee.branch_id,
                status: employee.employment_status,
                isManager: Number(directReports.n) > 0,
              }
            : null,
        };
      });
    },

    async changePassword(auth, { currentPassword, newPassword }, meta) {
      return withTenant(db, auth.organizationId, async (trx) => {
        const user = await trx('users')
          .where({ organization_id: auth.organizationId, id: auth.userId })
          .first('password_hash');
        if (!(await verifyPassword(user?.password_hash, currentPassword))) {
          throw new AppError(400, 'INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
        }
        if (currentPassword === newPassword) {
          throw new AppError(400, 'PASSWORD_UNCHANGED', 'Choose a different password');
        }
        await trx('users')
          .where({ organization_id: auth.organizationId, id: auth.userId })
          .update({
            password_hash: await hashPassword(newPassword),
            must_change_password: false,
            updated_at: trx.fn.now(),
          });
        // End every other session; keep the current one.
        const current = await trx('auth_sessions')
          .where({ organization_id: auth.organizationId, id: auth.sessionId })
          .first('family_id');
        await trx('auth_sessions')
          .where({ organization_id: auth.organizationId, user_id: auth.userId })
          .whereNot('family_id', current?.family_id ?? null)
          .whereNull('revoked_at')
          .update({ revoked_at: trx.fn.now(), revoke_reason: 'password_changed' });
        await recordAudit(trx, {
          organizationId: auth.organizationId,
          actorUserId: auth.userId,
          action: 'auth.password_changed',
          entityType: 'user',
          entityId: auth.userId,
          ip: meta.ip,
          requestId: meta.requestId,
        });
      });
    },
  };
}
