import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { rateLimit } from '../../core/rate-limit.js';
import { ROLES } from '../staff-access/permissions.js';
import { passwordSchema } from './passwords.js';
import { mobileSchema } from '../../core/phone.js';
import { requireCsrfHeader } from './middleware.js';

export const REFRESH_COOKIE = 'hos_refresh';
const COOKIE_PATH = '/api/v1/auth';

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(256),
});

const companySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, 'Enter your company code');
const employeeOtpRequestSchema = z.object({ company: companySchema, mobile: mobileSchema });
const employeeOtpVerifySchema = z.object({
  company: companySchema,
  mobile: mobileSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code'),
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
    employee: auth.employee,
  };
}

export function authRouter({ config, authService, authenticate, rateLimitStore, employeeLogin }) {
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

  // ---------------------------------------------------------------- employee mobile + OTP sign-in
  const otpLimiterByIp = rateLimit({
    store: rateLimitStore,
    prefix: 'emp-otp-ip',
    limit: 30,
    windowSec: 15 * 60,
    key: (req) => req.ip ?? 'unknown',
  });
  const mobileKey = (req) =>
    String(req.body?.mobile ?? '')
      .replace(/\D/g, '')
      .slice(-10);
  const otpRequestLimiterByMobile = rateLimit({
    store: rateLimitStore,
    prefix: 'emp-otp-req-mobile',
    limit: 10,
    windowSec: 15 * 60,
    key: mobileKey,
  });
  // Each code also allows only 5 wrong attempts (see otp module); this caps guessing across codes.
  const otpVerifyLimiterByMobile = rateLimit({
    store: rateLimitStore,
    prefix: 'emp-otp-verify-mobile',
    limit: 25,
    windowSec: 15 * 60,
    key: mobileKey,
  });

  router.post(
    '/employee/request-otp',
    otpLimiterByIp,
    otpRequestLimiterByMobile,
    async (req, res) => {
      const body = validate(employeeOtpRequestSchema, req.body);
      const r = await employeeLogin.requestOtp({ ...body, ip: req.ip ?? null });
      res.status(202).json({
        message: r.demoCode
          ? 'Demo hospital: the code is shown below instead of being sent by SMS.'
          : 'If this mobile number is registered with this company, a 6-digit code has been sent by SMS.',
        expiresInSeconds: 300,
        ...(r.demoCode ? { demoCode: r.demoCode } : {}),
      });
    },
  );

  router.post(
    '/employee/verify-otp',
    otpLimiterByIp,
    otpVerifyLimiterByMobile,
    async (req, res) => {
      const body = validate(employeeOtpVerifySchema, req.body);
      const result = await employeeLogin.verifyOtp({ ...body, meta: meta(req) });
      setRefreshCookie(res, result.refreshToken);
      res.json({ accessToken: result.accessToken, expiresIn: result.expiresIn });
    },
  );

  // ---------------------------------------------------------------- one-time invite links
  const inviteLimiter = rateLimit({
    store: rateLimitStore,
    prefix: 'invite-ip',
    limit: 30,
    windowSec: 15 * 60,
    key: (req) => req.ip ?? 'unknown',
  });
  router.get('/invite/:token', inviteLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await authService.inviteInfo(req.params.token));
  });
  router.post('/invite/accept', inviteLimiter, requireCsrfHeader, async (req, res) => {
    const body = validate(
      z.object({ token: z.string().min(20).max(200), password: passwordSchema }).strict(),
      req.body,
    );
    const result = await authService.acceptInvite({ ...body, meta: meta(req) });
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
