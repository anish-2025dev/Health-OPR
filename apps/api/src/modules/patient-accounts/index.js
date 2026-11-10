import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { withSystem, withTenant } from '../../core/db.js';
import { AppError, notFound, unauthorized } from '../../core/errors.js';
import { maskMobile, mobileSchema } from '../../core/phone.js';
import { rateLimit } from '../../core/rate-limit.js';
import { SmsNotConfiguredError } from '../../integrations/sms/index.js';
import { recordAudit } from '../audit/index.js';
import { hashToken, newRefreshToken } from '../authentication/tokens.js';
import { requireCsrfHeader } from '../authentication/middleware.js';
import { upsertContact } from '../patients/service.js';

/**
 * Patient accounts (ADR 0009): sign in to the patient website with phone + OTP, stay signed in on the
 * device with a rotating refresh cookie, and join hospitals with their code once.
 *
 * The access token has its own audience and key, so it can never call staff APIs, and staff tokens
 * can never call patient APIs.
 */
const AUDIENCE = 'healthos-patient';
const ISSUER = 'healthos-api';
const ACCESS_SECONDS = 15 * 60;
export const PATIENT_REFRESH_COOKIE = 'hos_patient_refresh';
const COOKIE_PATH = '/api/v1/patient-auth';
const OTP_TTL_SECONDS = 300;
const OTP_MAX_ATTEMPTS = 5;
const OTP_COOLDOWN_SECONDS = 30;
const OTP_MAX_PER_WINDOW = 5;

const invalidCode = () =>
  new AppError(400, 'OTP_INVALID', 'The code is incorrect or has expired. Request a new code.');

export function createPatientTokens(config) {
  const key = new TextEncoder().encode(
    `${config.APP_SECRET_KEY || randomBytes(48).toString('hex')}:patient-account`,
  );
  return {
    async sign(accountId) {
      return new SignJWT({})
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(accountId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${ACCESS_SECONDS}s`)
        .sign(key);
    },
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

/** Express middleware: sets req.patient = { accountId, phone } from a patient access token. */
export function authenticatePatient({ db, tokens }) {
  return async (req, res, next) => {
    try {
      const [scheme, token] = (req.get('authorization') ?? '').split(' ');
      if (scheme !== 'Bearer' || !token) throw unauthorized();
      const accountId = await tokens.verify(token);
      if (!accountId) throw unauthorized('Your session has expired. Please sign in again.');
      const account = await withSystem(db, (trx) =>
        trx('patient_accounts')
          .where({ id: accountId, status: 'active' })
          .first('id', 'phone_e164'),
      );
      if (!account) throw unauthorized();
      req.patient = { accountId: account.id, phone: account.phone_e164 };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** The hospital membership for the signed-in account, or null. */
export async function membership(db, accountId, organizationId) {
  return withSystem(db, (trx) =>
    trx('patient_account_clinics')
      .where({ account_id: accountId, organization_id: organizationId })
      .first('contact_id'),
  );
}

export function patientAuthRouter({ db, config, sms, tokens, rateLimitStore }) {
  const router = Router();
  const days = config.PATIENT_SESSION_DAYS ?? 30;
  const cookieOptions = {
    httpOnly: true,
    secure: config.APP_ENV === 'production' || config.APP_ENV === 'staging',
    sameSite: 'strict',
    path: COOKIE_PATH,
  };
  const otpKey = config.APP_SECRET_KEY || 'development-only-otp-key';
  const digest = (id, code) => createHmac('sha256', otpKey).update(`${id}:${code}`).digest();
  const phoneKey = (req) =>
    String(req.body?.phone ?? '')
      .replace(/\D/g, '')
      .slice(-10);
  const byIp = rateLimit({
    store: rateLimitStore,
    prefix: 'pat-otp-ip',
    limit: 30,
    windowSec: 900,
    key: (r) => r.ip ?? 'unknown',
  });
  const requestByPhone = rateLimit({
    store: rateLimitStore,
    prefix: 'pat-otp-req',
    limit: 10,
    windowSec: 900,
    key: phoneKey,
  });
  const verifyByPhone = rateLimit({
    store: rateLimitStore,
    prefix: 'pat-otp-verify',
    limit: 25,
    windowSec: 900,
    key: phoneKey,
  });

  async function startSession(trx, accountId, req) {
    const refresh = newRefreshToken();
    await trx('patient_account_sessions').insert({
      account_id: accountId,
      refresh_token_hash: hashToken(refresh),
      expires_at: new Date(Date.now() + days * 86_400_000),
      user_agent: req.get('user-agent')?.slice(0, 300) ?? null,
      ip: req.ip ?? null,
    });
    return refresh;
  }
  const respond = async (res, accountId, refresh) => {
    res.cookie(PATIENT_REFRESH_COOKIE, refresh, { ...cookieOptions, maxAge: days * 86_400_000 });
    res.json({ accessToken: await tokens.sign(accountId), expiresIn: ACCESS_SECONDS });
  };

  router.post('/otp/request', byIp, requestByPhone, async (req, res) => {
    const { phone } = validate(z.object({ phone: mobileSchema }).strict(), req.body);
    await withSystem(db, async (trx) => {
      const recent = await trx('patient_account_otps')
        .where({ phone_e164: phone })
        .where('created_at', '>', trx.raw("now() - interval '15 minutes'"))
        .orderBy('created_at', 'desc')
        .select('created_at');
      if (recent.length >= OTP_MAX_PER_WINDOW) {
        throw new AppError(
          429,
          'OTP_RATE_LIMITED',
          'Too many codes requested. Try again in 15 minutes.',
        );
      }
      if (
        recent[0] &&
        Date.now() - new Date(recent[0].created_at).getTime() < OTP_COOLDOWN_SECONDS * 1000
      ) {
        throw new AppError(
          429,
          'OTP_COOLDOWN',
          `Please wait ${OTP_COOLDOWN_SECONDS} seconds before requesting another code.`,
        );
      }
      await trx('patient_account_otps')
        .where({ phone_e164: phone })
        .whereNull('consumed_at')
        .update({ consumed_at: trx.fn.now() });
      const id = randomUUID();
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await trx('patient_account_otps').insert({
        id,
        phone_e164: phone,
        code_hash: digest(id, code).toString('hex'),
        expires_at: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
        ip: req.ip ?? null,
      });
      try {
        await sms.sendOtp({ to: phone, code, purpose: 'patient_login' });
      } catch (err) {
        if (err instanceof SmsNotConfiguredError) {
          throw new AppError(
            503,
            'SMS_NOT_CONFIGURED',
            'SMS is not set up yet. Please ask at the reception.',
          );
        }
        throw new AppError(502, 'SMS_SEND_FAILED', 'Could not send the SMS. Please try again.');
      }
    });
    res.status(202).json({ expiresInSeconds: OTP_TTL_SECONDS });
  });

  router.post('/otp/verify', byIp, verifyByPhone, async (req, res) => {
    const { phone, code } = validate(
      z.object({ phone: mobileSchema, code: z.string().regex(/^\d{6}$/) }).strict(),
      req.body,
    );
    // Pre-account sign-in: no tenant is involved yet.
    const outcome = await withSystem(db, async (trx) => {
      const challenge = await trx('patient_account_otps')
        .where({ phone_e164: phone })
        .whereNull('consumed_at')
        .orderBy('created_at', 'desc')
        .forUpdate()
        .first();
      if (!challenge || new Date(challenge.expires_at) <= new Date())
        return { error: invalidCode() };
      if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
        return {
          error: new AppError(
            429,
            'OTP_TOO_MANY_ATTEMPTS',
            'Too many wrong attempts. Request a new code.',
          ),
        };
      }
      const expected = Buffer.from(challenge.code_hash, 'hex');
      const actual = digest(challenge.id, code);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        await trx('patient_account_otps').where({ id: challenge.id }).increment('attempts', 1);
        return { error: invalidCode() };
      }
      await trx('patient_account_otps')
        .where({ id: challenge.id })
        .update({ consumed_at: trx.fn.now() });
      await trx('patient_accounts').insert({ phone_e164: phone }).onConflict('phone_e164').ignore();
      const account = await trx('patient_accounts').where({ phone_e164: phone }).first();
      if (account.status !== 'active')
        return { error: new AppError(403, 'ACCOUNT_DISABLED', 'This account is disabled') };
      await trx('patient_accounts')
        .where({ id: account.id })
        .update({ last_login_at: trx.fn.now() });
      return { accountId: account.id, refresh: await startSession(trx, account.id, req) };
    });
    if (outcome.error) throw outcome.error;
    await respond(res, outcome.accountId, outcome.refresh);
  });

  // Rotating refresh: each use replaces the token; reusing an old one ends every session (theft signal).
  router.post('/refresh', requireCsrfHeader, async (req, res) => {
    const token = req.cookies?.[PATIENT_REFRESH_COOKIE];
    if (!token) throw unauthorized();
    const result = await withSystem(db, async (trx) => {
      const s = await trx('patient_account_sessions')
        .where({ refresh_token_hash: hashToken(token) })
        .forUpdate()
        .first();
      if (!s) return null;
      if (s.revoked_at) {
        await trx('patient_account_sessions')
          .where({ account_id: s.account_id })
          .whereNull('revoked_at')
          .update({ revoked_at: trx.fn.now() });
        return null;
      }
      if (new Date(s.expires_at) <= new Date()) return null;
      const account = await trx('patient_accounts')
        .where({ id: s.account_id, status: 'active' })
        .first('id');
      if (!account) return null;
      await trx('patient_account_sessions')
        .where({ id: s.id })
        .update({ revoked_at: trx.fn.now(), last_used_at: trx.fn.now() });
      return { accountId: account.id, refresh: await startSession(trx, account.id, req) };
    });
    if (!result) {
      res.clearCookie(PATIENT_REFRESH_COOKIE, cookieOptions);
      throw unauthorized('Please sign in again');
    }
    await respond(res, result.accountId, result.refresh);
  });

  router.post('/logout', requireCsrfHeader, async (req, res) => {
    const token = req.cookies?.[PATIENT_REFRESH_COOKIE];
    if (token) {
      await withSystem(db, (trx) =>
        trx('patient_account_sessions')
          .where({ refresh_token_hash: hashToken(token) })
          .whereNull('revoked_at')
          .update({ revoked_at: trx.fn.now() }),
      );
    }
    res.clearCookie(PATIENT_REFRESH_COOKIE, cookieOptions);
    res.status(204).end();
  });

  return router;
}

/** /patient: the signed-in account and the hospitals it has joined. */
export function patientAccountRouter({ db, authenticate }) {
  const router = Router();
  router.use(authenticate);

  const clinics = (accountId) =>
    withSystem(db, (trx) =>
      trx('patient_account_clinics as m')
        .join('organizations as o', 'o.id', 'm.organization_id')
        .where({ 'm.account_id': accountId, 'o.status': 'active' })
        .orderBy('m.joined_at')
        .select('o.slug', 'o.name', 'm.joined_at'),
    );

  router.get('/me', async (req, res) => {
    const list = await clinics(req.patient.accountId);
    res.json({
      phone: maskMobile(req.patient.phone),
      clinics: list.map((c) => ({ code: c.slug, name: c.name, joinedAt: c.joined_at })),
    });
  });

  // Joining needs the hospital's code once; afterwards the hospital is listed under "My hospitals".
  router.post('/clinics', async (req, res) => {
    const { code } = validate(
      z
        .object({
          code: z
            .string()
            .trim()
            .toLowerCase()
            .regex(/^[a-z0-9-]{2,63}$/, 'Enter the hospital code'),
        })
        .strict(),
      req.body,
    );
    const org = await withSystem(db, (trx) =>
      trx('organizations').where({ slug: code, status: 'active' }).first('id', 'name', 'slug'),
    );
    if (!org)
      throw notFound('No hospital found with this code. Check the code with the reception.');
    const contact = await withTenant(db, org.id, async (trx) => {
      const c = await upsertContact(trx, org.id, req.patient.phone, { verified: true });
      await recordAudit(trx, {
        organizationId: org.id,
        action: 'portal.account_joined',
        entityType: 'contact',
        entityId: c.id,
        ip: req.ip ?? null,
        requestId: req.id,
      });
      return c;
    });
    await withSystem(db, (trx) =>
      trx('patient_account_clinics')
        .insert({
          account_id: req.patient.accountId,
          organization_id: org.id,
          contact_id: contact.id,
        })
        .onConflict(['account_id', 'organization_id'])
        .ignore(),
    );
    res.status(201).json({ code: org.slug, name: org.name });
  });

  router.delete('/clinics/:code', async (req, res) => {
    const org = await withSystem(db, (trx) =>
      trx('organizations')
        .where({ slug: String(req.params.code) })
        .first('id'),
    );
    if (org) {
      await withSystem(db, (trx) =>
        trx('patient_account_clinics')
          .where({ account_id: req.patient.accountId, organization_id: org.id })
          .delete(),
      );
    }
    res.status(204).end();
  });

  return router;
}
