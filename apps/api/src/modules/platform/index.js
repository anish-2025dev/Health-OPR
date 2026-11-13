import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { isUuid, withSystem, withTenant } from '../../core/db.js';
import { AppError, notFound, unauthorized } from '../../core/errors.js';
import { rateLimit } from '../../core/rate-limit.js';
import { recordAudit } from '../audit/index.js';
import {
  dummyHash,
  hashPassword,
  passwordSchema,
  verifyPassword,
} from '../authentication/passwords.js';
import { hashToken, newRefreshToken } from '../authentication/tokens.js';
import { requireCsrfHeader } from '../authentication/middleware.js';
import { createInvite, inviteUrl } from '../authentication/invites.js';
import { createOrganizationWithOwner } from '../organizations/index.js';

/**
 * Platform administration (ADR 0011): the operator's team onboards and manages client hospitals.
 *
 * - Separate login: platform tokens use their own audience and key; hospital APIs reject them and the
 *   platform API rejects hospital tokens.
 * - Platform admins see counts and owner contact details only, never patient or employee records.
 * - Hospital-level reads here are cross-tenant by nature (a list of all hospitals), so they run in the
 *   system context, read only aggregates, and every change is written to platform_audit_logs and to
 *   the hospital's own audit log.
 */
const AUDIENCE = 'healthos-platform';
const ISSUER = 'healthos-api';
const ACCESS_SECONDS = 15 * 60;
const SESSION_DAYS = 7;
export const PLATFORM_REFRESH_COOKIE = 'hos_platform_refresh';
const COOKIE_PATH = '/api/v1/platform/auth';
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export function createPlatformTokens(config) {
  const key = new TextEncoder().encode(
    `${config.APP_SECRET_KEY || randomBytes(48).toString('hex')}:platform-admin`,
  );
  return {
    sign: (adminId) =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(adminId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${ACCESS_SECONDS}s`)
        .sign(key),
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key, {
          issuer: ISSUER,
          audience: AUDIENCE,
          algorithms: ['HS256'],
        });
        return payload.sub ?? null;
      } catch {
        return null;
      }
    },
  };
}

async function platformAudit(trx, req, entry) {
  await trx('platform_audit_logs').insert({
    admin_id: req.platform?.adminId ?? entry.adminId ?? null,
    action: entry.action,
    organization_id: entry.organizationId ?? null,
    reason: entry.reason ?? null,
    metadata: entry.metadata ?? {},
    ip: req.ip ?? null,
  });
}

export function platformRouter({ db, config, rateLimitStore }) {
  const router = Router();
  const tokens = createPlatformTokens(config);
  const cookieOptions = {
    httpOnly: true,
    secure: config.APP_ENV === 'production' || config.APP_ENV === 'staging',
    sameSite: 'strict',
    path: COOKIE_PATH,
  };
  const limiter = rateLimit({
    store: rateLimitStore,
    prefix: 'platform-login',
    limit: 20,
    windowSec: 900,
    key: (r) => r.ip ?? 'unknown',
  });

  async function startSession(trx, adminId, req) {
    const refresh = newRefreshToken();
    await trx('platform_sessions').insert({
      admin_id: adminId,
      refresh_token_hash: hashToken(refresh),
      expires_at: new Date(Date.now() + SESSION_DAYS * 86_400_000),
      ip: req.ip ?? null,
      user_agent: req.get('user-agent')?.slice(0, 300) ?? null,
    });
    return refresh;
  }
  const respond = async (res, adminId, refresh) => {
    res.cookie(PLATFORM_REFRESH_COOKIE, refresh, {
      ...cookieOptions,
      maxAge: SESSION_DAYS * 86_400_000,
    });
    res.json({ accessToken: await tokens.sign(adminId), expiresIn: ACCESS_SECONDS });
  };

  // ---------------------------------------------------------------- sign-in
  router.post('/auth/login', limiter, async (req, res) => {
    const { email, password } = validate(
      z
        .object({
          email: z.string().trim().toLowerCase().email(),
          password: z.string().min(1).max(200),
        })
        .strict(),
      req.body,
    );
    const admin = await withSystem(db, (trx) =>
      trx('platform_admins').whereRaw('lower(email) = ?', [email]).first(),
    );
    if (!admin) {
      await verifyPassword(await dummyHash(), password);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
      throw new AppError(
        423,
        'ACCOUNT_LOCKED',
        'Too many failed attempts. Try again in 15 minutes.',
      );
    }
    if (!(await verifyPassword(admin.password_hash, password))) {
      const failed = admin.failed_login_count + 1;
      await withSystem(db, (trx) =>
        trx('platform_admins')
          .where({ id: admin.id })
          .update({
            failed_login_count: failed,
            locked_until:
              failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
          }),
      );
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    if (admin.status !== 'active')
      throw new AppError(403, 'ACCOUNT_DISABLED', 'This account is disabled');
    const refresh = await withSystem(db, async (trx) => {
      await trx('platform_admins')
        .where({ id: admin.id })
        .update({ failed_login_count: 0, locked_until: null, last_login_at: trx.fn.now() });
      await platformAudit(trx, req, { adminId: admin.id, action: 'platform.login' });
      return startSession(trx, admin.id, req);
    });
    await respond(res, admin.id, refresh);
  });

  router.post('/auth/refresh', requireCsrfHeader, async (req, res) => {
    const token = req.cookies?.[PLATFORM_REFRESH_COOKIE];
    if (!token) throw unauthorized();
    const result = await withSystem(db, async (trx) => {
      const s = await trx('platform_sessions')
        .where({ refresh_token_hash: hashToken(token) })
        .forUpdate()
        .first();
      if (!s) return null;
      if (s.revoked_at) {
        // A rotated token was reused: end every session of this admin.
        await trx('platform_sessions')
          .where({ admin_id: s.admin_id })
          .whereNull('revoked_at')
          .update({ revoked_at: trx.fn.now() });
        return null;
      }
      if (new Date(s.expires_at) <= new Date()) return null;
      const admin = await trx('platform_admins')
        .where({ id: s.admin_id, status: 'active' })
        .first('id');
      if (!admin) return null;
      await trx('platform_sessions').where({ id: s.id }).update({ revoked_at: trx.fn.now() });
      return { adminId: admin.id, refresh: await startSession(trx, admin.id, req) };
    });
    if (!result) {
      res.clearCookie(PLATFORM_REFRESH_COOKIE, cookieOptions);
      throw unauthorized('Please sign in again');
    }
    await respond(res, result.adminId, result.refresh);
  });

  router.post('/auth/logout', requireCsrfHeader, async (req, res) => {
    const token = req.cookies?.[PLATFORM_REFRESH_COOKIE];
    if (token) {
      await withSystem(db, (trx) =>
        trx('platform_sessions')
          .where({ refresh_token_hash: hashToken(token) })
          .whereNull('revoked_at')
          .update({ revoked_at: trx.fn.now() }),
      );
    }
    res.clearCookie(PLATFORM_REFRESH_COOKIE, cookieOptions);
    res.status(204).end();
  });

  // ---------------------------------------------------------------- everything below needs a platform admin
  router.use(async (req, res, next) => {
    try {
      const [scheme, token] = (req.get('authorization') ?? '').split(' ');
      if (scheme !== 'Bearer' || !token) throw unauthorized();
      const adminId = await tokens.verify(token);
      if (!adminId) throw unauthorized('Your session has expired. Please sign in again.');
      const admin = await withSystem(db, (trx) =>
        trx('platform_admins')
          .where({ id: adminId, status: 'active' })
          .first('id', 'email', 'full_name', 'must_change_password'),
      );
      if (!admin) throw unauthorized();
      req.platform = {
        adminId: admin.id,
        email: admin.email,
        fullName: admin.full_name,
        mustChangePassword: admin.must_change_password,
      };
      const route = `${req.method} ${req.path}`;
      if (admin.must_change_password && !['GET /me', 'POST /me/password'].includes(route)) {
        throw new AppError(
          403,
          'PASSWORD_CHANGE_REQUIRED',
          'Please set a new password to continue',
        );
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', (req, res) => {
    res.json({
      email: req.platform.email,
      fullName: req.platform.fullName,
      mustChangePassword: req.platform.mustChangePassword,
    });
  });

  router.post('/me/password', async (req, res) => {
    const body = validate(
      z
        .object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema })
        .strict(),
      req.body,
    );
    const admin = await withSystem(db, (trx) =>
      trx('platform_admins').where({ id: req.platform.adminId }).first('password_hash'),
    );
    if (!(await verifyPassword(admin.password_hash, body.currentPassword))) {
      throw new AppError(400, 'INVALID_PASSWORD', 'Current password is incorrect');
    }
    if (body.currentPassword === body.newPassword)
      throw new AppError(400, 'VALIDATION_ERROR', 'Choose a new password');
    const hash = await hashPassword(body.newPassword);
    await withSystem(db, async (trx) => {
      await trx('platform_admins')
        .where({ id: req.platform.adminId })
        .update({ password_hash: hash, must_change_password: false });
      await platformAudit(trx, req, { action: 'platform.password_changed' });
    });
    res.status(204).end();
  });

  // ---------------------------------------------------------------- hospitals
  const count = (trx, table, where = {}) =>
    trx(table)
      .where(where)
      .groupBy('organization_id')
      .select('organization_id', trx.raw('count(*)::int AS n'));

  async function summaries(trx, ids = null) {
    const q = trx('organizations as o')
      .orderBy('o.created_at', 'desc')
      .select('o.id', 'o.name', 'o.slug', 'o.status', 'o.created_at');
    if (ids) q.whereIn('o.id', ids);
    const orgs = await q;
    const [branches, staff, employees, patients] = await Promise.all([
      count(trx, 'branches'),
      count(trx, 'users').whereNotNull('email'),
      count(trx, 'employees').whereIn('employment_status', ['active', 'on_notice']),
      count(trx, 'patients', { status: 'active' }),
    ]);
    const owners = await trx('user_role_assignments as r')
      .join('users as u', 'u.id', 'r.user_id')
      .where('r.role_key', 'organization_owner')
      .select(
        'r.organization_id',
        'u.id',
        'u.full_name',
        'u.email',
        'u.last_login_at',
        trx.raw('(u.password_hash IS NOT NULL) AS has_password'),
      );
    const by = (rows) => Object.fromEntries(rows.map((r) => [r.organization_id, r.n]));
    const b = by(branches);
    const s = by(staff);
    const e = by(employees);
    const p = by(patients);
    return orgs.map((o) => ({
      id: o.id,
      name: o.name,
      code: o.slug,
      status: o.status,
      createdAt: o.created_at,
      counts: {
        branches: b[o.id] ?? 0,
        staff: s[o.id] ?? 0,
        employees: e[o.id] ?? 0,
        patients: p[o.id] ?? 0,
      },
      owners: owners
        .filter((x) => x.organization_id === o.id)
        .map((x) => ({
          id: x.id,
          fullName: x.full_name,
          email: x.email,
          lastLoginAt: x.last_login_at,
          activated: x.has_password,
        })),
    }));
  }

  router.get('/organizations', async (req, res) => {
    res.json({ data: await withSystem(db, (trx) => summaries(trx)) });
  });

  router.get('/organizations/:id', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Hospital not found');
    const [org] = await withSystem(db, (trx) => summaries(trx, [req.params.id]));
    if (!org) throw notFound('Hospital not found');
    const history = await withSystem(db, (trx) =>
      trx('platform_audit_logs as l')
        .leftJoin('platform_admins as a', 'a.id', 'l.admin_id')
        .where('l.organization_id', org.id)
        .orderBy('l.created_at', 'desc')
        .limit(50)
        .select('l.action', 'l.reason', 'l.created_at', 'a.full_name as admin'),
    );
    res.json({
      ...org,
      history: history.map((h) => ({
        action: h.action,
        reason: h.reason,
        by: h.admin,
        at: h.created_at,
      })),
    });
  });

  router.post('/organizations', async (req, res) => {
    const body = validate(
      z
        .object({
          name: z.string().trim().min(2).max(200),
          code: z
            .string()
            .trim()
            .toLowerCase()
            .regex(
              /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/,
              'Use 3–50 lowercase letters, digits or dashes',
            ),
          branchName: z.string().trim().min(2).max(200).default('Main'),
          branchCode: z
            .string()
            .trim()
            .toUpperCase()
            .regex(/^[A-Z0-9-]{2,20}$/)
            .default('MAIN'),
          ownerName: z.string().trim().min(2).max(200),
          ownerEmail: z.string().trim().toLowerCase().email().max(254),
        })
        .strict(),
      req.body,
    );
    let created;
    try {
      created = await createOrganizationWithOwner(db, {
        name: body.name,
        slug: body.code,
        owner: { email: body.ownerEmail, fullName: body.ownerName },
        branch: { name: body.branchName, code: body.branchCode },
        passwordHash: null, // the owner sets a password through the invite link
        source: 'platform_console',
      });
    } catch (err) {
      if (err.code === '23505') {
        if (/slug/.test(err.constraint ?? ''))
          throw new AppError(409, 'CODE_TAKEN', 'This hospital code is already used');
        if (/email/.test(err.constraint ?? ''))
          throw new AppError(409, 'EMAIL_TAKEN', 'This email already has a HealthOS login');
      }
      throw err;
    }
    const orgId = created.organization.id;
    const invite = await withTenant(db, orgId, (trx) =>
      createInvite(trx, {
        organizationId: orgId,
        userId: created.owner.id,
        platformAdminId: req.platform.adminId,
      }),
    );
    await withSystem(db, (trx) =>
      platformAudit(trx, req, {
        action: 'platform.organization_created',
        organizationId: orgId,
        metadata: { code: body.code },
      }),
    );
    const [summary] = await withSystem(db, (trx) => summaries(trx, [orgId]));
    res.status(201).json({
      ...summary,
      invite: { url: inviteUrl(config, invite.token), expiresAt: invite.expiresAt },
    });
  });

  // A new one-time sign-in link for an owner (first sign-in, or a forgotten password).
  router.post('/organizations/:id/invites', async (req, res) => {
    const body = validate(z.object({ userId: z.string().uuid() }).strict(), req.body);
    if (!isUuid(req.params.id)) throw notFound('Hospital not found');
    const orgId = req.params.id;
    const owner = await withSystem(db, (trx) =>
      trx('user_role_assignments as r')
        .join('users as u', 'u.id', 'r.user_id')
        .where({
          'r.organization_id': orgId,
          'r.user_id': body.userId,
          'r.role_key': 'organization_owner',
        })
        .first('u.id', 'u.status'),
    );
    if (!owner) throw notFound('Owner not found');
    const invite = await withTenant(db, orgId, async (trx) => {
      const inv = await createInvite(trx, {
        organizationId: orgId,
        userId: owner.id,
        platformAdminId: req.platform.adminId,
      });
      await recordAudit(trx, {
        organizationId: orgId,
        action: 'user.invite_created',
        entityType: 'user',
        entityId: owner.id,
        metadata: { by: 'platform' },
      });
      return inv;
    });
    await withSystem(db, (trx) =>
      platformAudit(trx, req, { action: 'platform.invite_created', organizationId: orgId }),
    );
    res.status(201).json({ url: inviteUrl(config, invite.token), expiresAt: invite.expiresAt });
  });

  for (const [action, status] of [
    ['suspend', 'suspended'],
    ['reactivate', 'active'],
  ]) {
    router.post(`/organizations/:id/${action}`, async (req, res) => {
      const { reason } = validate(
        z.object({ reason: z.string().trim().min(3).max(500) }).strict(),
        req.body,
      );
      if (!isUuid(req.params.id)) throw notFound('Hospital not found');
      const orgId = req.params.id;
      const org = await withSystem(db, (trx) =>
        trx('organizations').where({ id: orgId }).first('status'),
      );
      if (!org) throw notFound('Hospital not found');
      if (org.status === status) throw new AppError(409, 'NO_CHANGE', `Already ${status}`);
      await withSystem(db, async (trx) => {
        await trx('organizations')
          .where({ id: orgId })
          .update({ status, updated_at: trx.fn.now() });
        if (status === 'suspended') {
          // Everyone at the hospital is signed out at once; logins are refused while suspended.
          await trx('auth_sessions')
            .where({ organization_id: orgId })
            .whereNull('revoked_at')
            .update({ revoked_at: trx.fn.now(), revoke_reason: 'organization_suspended' });
        }
        await platformAudit(trx, req, {
          action: `platform.organization_${action === 'suspend' ? 'suspended' : 'reactivated'}`,
          organizationId: orgId,
          reason,
        });
      });
      await withTenant(db, orgId, (trx) =>
        recordAudit(trx, {
          organizationId: orgId,
          action: `organization.${status === 'active' ? 'reactivated' : 'suspended'}`,
          entityType: 'organization',
          entityId: orgId,
          reason,
          metadata: { by: 'platform' },
        }),
      );
      const [summary] = await withSystem(db, (trx) => summaries(trx, [orgId]));
      res.json(summary);
    });
  }

  router.get('/audit', async (req, res) => {
    const rows = await withSystem(db, (trx) =>
      trx('platform_audit_logs as l')
        .leftJoin('platform_admins as a', 'a.id', 'l.admin_id')
        .leftJoin('organizations as o', 'o.id', 'l.organization_id')
        .orderBy('l.created_at', 'desc')
        .limit(200)
        .select(
          'l.action',
          'l.reason',
          'l.created_at',
          'a.full_name as admin',
          'o.name as organization',
        ),
    );
    res.json({
      data: rows.map((r) => ({
        action: r.action,
        reason: r.reason,
        by: r.admin,
        organization: r.organization,
        at: r.created_at,
      })),
    });
  });

  return router;
}
