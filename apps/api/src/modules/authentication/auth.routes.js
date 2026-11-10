import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { rateLimit } from '../../core/rate-limit.js';
import { ROLES } from '../staff-access/permissions.js';
import { passwordSchema } from './passwords.js';
import { requireCsrfHeader } from './middleware.js';

export const REFRESH_COOKIE = 'hos_refresh';
const COOKIE_PATH = '/api/v1/auth';

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(256),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

const meta = (req) => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
  requestId: req.id,
});

export function presentMe(auth) {
  return {
    user: {
      id: auth.userId,
      email: auth.email,
      fullName: auth.fullName,
      mustChangePassword: auth.mustChangePassword,
    },
    organization: auth.organization,
    roles: auth.roles.map((r) => ({ ...r, label: ROLES[r.role]?.label ?? r.role })),
    permissions: [...auth.permissions].sort(),
    branchIds: auth.branchIds,
  };
}

export function authRouter({ config, authService, authenticate, rateLimitStore }) {
  const router = Router();
  const secureCookie = config.APP_ENV === 'production' || config.APP_ENV === 'staging';
  const cookieOptions = {
    httpOnly: true,
    secure: secureCookie,
    sameSite: 'strict',
    path: COOKIE_PATH,
  };

  const setRefreshCookie = (res, token) =>
    res.cookie(REFRESH_COOKIE, token, {
      ...cookieOptions,
      maxAge: config.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60 * 1000,
    });

  const loginLimiterByIp = rateLimit({
    store: rateLimitStore,
    prefix: 'login-ip',
    limit: 30,
    windowSec: 15 * 60,
    key: (req) => req.ip ?? 'unknown',
  });
  const loginLimiterByEmail = rateLimit({
    store: rateLimitStore,
    prefix: 'login-email',
    limit: 10,
    windowSec: 15 * 60,
    key: (req) =>
      String(req.body?.email ?? '')
        .trim()
        .toLowerCase()
        .slice(0, 254),
  });

  router.post('/login', loginLimiterByIp, loginLimiterByEmail, async (req, res) => {
    const body = validate(loginSchema, req.body);
    const result = await authService.login({ ...body, meta: meta(req) });
    setRefreshCookie(res, result.refreshToken);
    res.json({ accessToken: result.accessToken, expiresIn: result.expiresIn });
  });

  router.post('/refresh', requireCsrfHeader, async (req, res) => {
    try {
      const result = await authService.refresh({
        refreshToken: req.cookies?.[REFRESH_COOKIE],
        meta: meta(req),
      });
      setRefreshCookie(res, result.refreshToken);
      res.json({ accessToken: result.accessToken, expiresIn: result.expiresIn });
    } catch (err) {
      if (err.code !== 'REFRESH_RACE') res.clearCookie(REFRESH_COOKIE, cookieOptions);
      throw err;
    }
  });

  router.post('/logout', requireCsrfHeader, async (req, res) => {
    await authService.logout({ refreshToken: req.cookies?.[REFRESH_COOKIE], meta: meta(req) });
    res.clearCookie(REFRESH_COOKIE, cookieOptions);
    res.status(204).end();
  });

  router.get('/me', authenticate, (req, res) => {
    res.json(presentMe(req.auth));
  });

  router.post('/change-password', authenticate, async (req, res) => {
    const body = validate(changePasswordSchema, req.body);
    await authService.changePassword(req.auth, body, meta(req));
    res.status(204).end();
  });

  return router;
}
