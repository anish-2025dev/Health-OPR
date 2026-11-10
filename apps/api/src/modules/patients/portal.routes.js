import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { isUuid, withSystem, withTenant } from '../../core/db.js';
import { AppError, notFound, unauthorized } from '../../core/errors.js';
import { maskMobile, mobileSchema } from '../../core/phone.js';
import { rateLimit } from '../../core/rate-limit.js';
import { SmsNotConfiguredError } from '../../integrations/sms/index.js';
import { recordAudit } from '../audit/index.js';
import { consentChoicesSchema } from './routes.js';
import {
  CONSENT_KEYS,
  RELATIONSHIPS,
  currentConsents,
  flagDuplicates,
  insertPatient,
  linkContact,
  possibleDuplicates,
  presentConsents,
  publishedNotice,
  recordConsents,
  upsertContact,
} from './service.js';

/**
 * Public clinic portal (the page behind the clinic's QR code). A person verifies their phone number by
 * OTP and can then register themselves and family members and manage their communication choices.
 *
 * - A portal token proves only that the person controls the phone number. It is a separate token type
 *   (different audience) and can never call staff APIs.
 * - OTP possession is not proof of authority over someone else (spec): family members registered here
 *   stay "pending" until staff authorize the relationship, and pending patients are not bookable.
 * - The portal never reveals other patients' records. Possible duplicates are flagged for staff.
 */
const PORTAL_AUDIENCE = 'healthos-patient-portal';
const ISSUER = 'healthos-api';
const PORTAL_TOKEN_SECONDS = 30 * 60;
const OTP_TTL_SECONDS = 300;
const OTP_MAX_ATTEMPTS = 5;
const OTP_COOLDOWN_SECONDS = 30;
const OTP_MAX_PER_WINDOW = 5;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const invalidCode = () =>
  new AppError(400, 'OTP_INVALID', 'The code is incorrect or has expired. Request a new code.');

const registerSchema = z
  .object({
    fullName: z.string().trim().min(2).max(200),
    dateOfBirth: DATE.refine(
      (d) => d <= new Date().toISOString().slice(0, 10),
      'Date of birth cannot be in the future',
    ),
    gender: z.enum(['female', 'male', 'other', 'undisclosed']).nullable().default(null),
    email: z.string().trim().toLowerCase().email().max(254).nullable().default(null),
    relationship: z.enum(RELATIONSHIPS),
    branchId: z.string().uuid().nullable().default(null),
    privacyNoticeAcknowledged: z.literal(true, {
      error: 'Please read and acknowledge the privacy notice',
    }),
    consents: consentChoicesSchema.default({}),
  })
  .strict();

export function portalRouter({ db, config, sms, rateLimitStore }) {
  const router = Router();
  const secret = new TextEncoder().encode(
    `${config.APP_SECRET_KEY || randomBytes(48).toString('hex')}:portal`,
  );
  const otpKey = config.APP_SECRET_KEY || 'development-only-otp-key';
  const digest = (id, code) => createHmac('sha256', otpKey).update(`${id}:${code}`).digest();

  async function findOrg(slug) {
    const org = await withSystem(db, (trx) =>
      trx('organizations').where({ slug, status: 'active' }).first('id', 'name', 'slug'),
    );
    if (!org) throw notFound('Clinic not found');
    return org;
  }

  const phoneKey = (req) =>
    String(req.body?.phone ?? '')
      .replace(/\D/g, '')
      .slice(-10);
  const byIp = rateLimit({
    store: rateLimitStore,
    prefix: 'portal-ip',
    limit: 60,
    windowSec: 15 * 60,
    key: (req) => req.ip ?? 'unknown',
  });
  const requestByPhone = rateLimit({
    store: rateLimitStore,
    prefix: 'portal-otp-req',
    limit: 10,
    windowSec: 15 * 60,
    key: phoneKey,
  });
  const verifyByPhone = rateLimit({
    store: rateLimitStore,
    prefix: 'portal-otp-verify',
    limit: 25,
    windowSec: 15 * 60,
    key: phoneKey,
  });

  /** Requires a portal token for the clinic in the URL. Sets req.portal = { org, contact }. */
  async function portalAuth(req, res, next) {
    try {
      const [scheme, token] = (req.get('authorization') ?? '').split(' ');
      if (scheme !== 'Bearer' || !token) throw unauthorized();
      let payload;
      try {
        ({ payload } = await jwtVerify(token, secret, {
          issuer: ISSUER,
          audience: PORTAL_AUDIENCE,
          algorithms: ['HS256'],
        }));
      } catch {
        throw unauthorized('Your session has expired. Verify your phone number again.');
      }
      const org = await findOrg(req.params.slug);
      if (payload.org !== org.id || !isUuid(payload.sub)) throw unauthorized();
      const contact = await withTenant(db, org.id, (trx) =>
        trx('contacts').where({ organization_id: org.id, id: payload.sub }).first(),
      );
      if (!contact) throw unauthorized();
      req.portal = { org, contact };
      next();
    } catch (err) {
      next(err);
    }
  }

  // ------------------------------------------------------------------ clinic landing page
  router.get('/:slug', byIp, async (req, res) => {
    const org = await findOrg(req.params.slug);
    const data = await withTenant(db, org.id, async (trx) => ({
      branches: await trx('branches')
        .where({ organization_id: org.id, status: 'active' })
        .orderBy('name')
        .select('id', 'name'),
      notice: await publishedNotice(trx, org.id),
    }));
    res.json({
      organization: { name: org.name, slug: org.slug },
      branches: data.branches,
      privacyNotice: data.notice
        ? {
            id: data.notice.id,
            version: data.notice.version,
            title: data.notice.title,
            content: data.notice.content,
          }
        : null,
    });
  });

  // ------------------------------------------------------------------ phone verification
  router.post('/:slug/otp/request', byIp, requestByPhone, async (req, res) => {
    const { phone } = validate(z.object({ phone: mobileSchema }).strict(), req.body);
    const org = await findOrg(req.params.slug);
    await withTenant(db, org.id, async (trx) => {
      const recent = await trx('portal_otp_challenges')
        .where({ organization_id: org.id, phone_e164: phone })
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
      await trx('portal_otp_challenges')
        .where({ organization_id: org.id, phone_e164: phone })
        .whereNull('consumed_at')
        .update({ consumed_at: trx.fn.now() });
      const id = randomUUID();
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await trx('portal_otp_challenges').insert({
        id,
        organization_id: org.id,
        phone_e164: phone,
        code_hash: digest(id, code).toString('hex'),
        expires_at: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
        ip: req.ip ?? null,
      });
      try {
        await sms.sendOtp({ to: phone, code, purpose: 'patient_portal' });
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

  router.post('/:slug/otp/verify', byIp, verifyByPhone, async (req, res) => {
    const { phone, code } = validate(
      z.object({ phone: mobileSchema, code: z.string().regex(/^\d{6}$/) }).strict(),
      req.body,
    );
    const org = await findOrg(req.params.slug);
    const outcome = await withTenant(db, org.id, async (trx) => {
      const challenge = await trx('portal_otp_challenges')
        .where({ organization_id: org.id, phone_e164: phone })
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
        await trx('portal_otp_challenges').where({ id: challenge.id }).increment('attempts', 1);
        return { error: invalidCode() };
      }
      await trx('portal_otp_challenges')
        .where({ id: challenge.id })
        .update({ consumed_at: trx.fn.now() });
      const contact = await upsertContact(trx, org.id, phone, { verified: true });
      await recordAudit(trx, {
        organizationId: org.id,
        action: 'portal.phone_verified',
        entityType: 'contact',
        entityId: contact.id,
        ip: req.ip ?? null,
        requestId: req.id,
      });
      return { contact };
    });
    if (outcome.error) throw outcome.error;
    const token = await new SignJWT({ org: org.id })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(outcome.contact.id)
      .setIssuer(ISSUER)
      .setAudience(PORTAL_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${PORTAL_TOKEN_SECONDS}s`)
      .sign(secret);
    res.json({ portalToken: token, expiresIn: PORTAL_TOKEN_SECONDS });
  });

  // ------------------------------------------------------------------ the verified person's profiles
  async function linkedPatients(trx, orgId, contactId) {
    const rows = await trx('contact_patient_links as l')
      .join('patients as p', 'p.id', 'l.patient_id')
      .where({ 'l.organization_id': orgId, 'l.contact_id': contactId, 'p.status': 'active' })
      .whereNot('l.authorization_status', 'revoked')
      .orderBy('l.created_at')
      .select(
        'p.id',
        'p.patient_number',
        'p.full_name',
        'l.relationship',
        'l.authorization_status',
      );
    const consents = await currentConsents(
      trx,
      orgId,
      rows.filter((r) => r.authorization_status === 'authorized').map((r) => r.id),
    );
    return rows.map((r) => ({
      id: r.id,
      patientNumber: r.authorization_status === 'authorized' ? r.patient_number : null,
      fullName: r.full_name,
      relationship: r.relationship,
      authorizationStatus: r.authorization_status,
      consents:
        r.authorization_status === 'authorized' ? presentConsents(consents[r.id]) : undefined,
    }));
  }

  router.get('/:slug/me', portalAuth, async (req, res) => {
    const { org, contact } = req.portal;
    const patients = await withTenant(db, org.id, (trx) => linkedPatients(trx, org.id, contact.id));
    res.json({ phone: maskMobile(contact.phone_e164), patients });
  });

  router.post('/:slug/patients', portalAuth, async (req, res) => {
    const body = validate(registerSchema, req.body);
    const { org, contact } = req.portal;
    const result = await withTenant(db, org.id, async (trx) => {
      if (body.branchId) {
        const b = await trx('branches')
          .where({ organization_id: org.id, id: body.branchId, status: 'active' })
          .first('id');
        if (!b) throw new AppError(400, 'VALIDATION_ERROR', 'Unknown branch');
      }
      const matches = await possibleDuplicates(trx, org.id, {
        fullName: body.fullName,
        dateOfBirth: body.dateOfBirth,
        contactIds: [contact.id],
      });
      // Same person already registered on this phone number: don't create a second record.
      const ownLinks = await trx('contact_patient_links')
        .where({ organization_id: org.id, contact_id: contact.id })
        .whereNot('authorization_status', 'revoked')
        .pluck('patient_id');
      const already = matches.find(
        (m) =>
          ownLinks.includes(m.patientId) &&
          m.reasons.includes('same_name') &&
          m.reasons.includes('same_date_of_birth'),
      );
      if (already) {
        throw new AppError(
          409,
          'ALREADY_REGISTERED',
          'This person is already registered on this phone number.',
        );
      }
      const hasSelf = await trx('contact_patient_links')
        .where({
          organization_id: org.id,
          contact_id: contact.id,
          relationship: 'self',
          authorization_status: 'authorized',
        })
        .first('id');
      const authorized = body.relationship === 'self' && !hasSelf;

      const patient = await insertPatient(trx, org.id, {
        full_name: body.fullName,
        date_of_birth: body.dateOfBirth,
        gender: body.gender,
        email: body.email,
        registered_branch_id: body.branchId,
        registration_source: 'portal',
      });
      await linkContact(trx, org.id, {
        contact_id: contact.id,
        patient_id: patient.id,
        relationship: body.relationship,
        authorization_status: authorized ? 'authorized' : 'pending',
        authorized_at: authorized ? trx.fn.now() : null,
        created_via: 'portal',
      });
      await recordConsents(
        trx,
        org.id,
        patient.id,
        {
          privacy_notice: true,
          ...Object.fromEntries(
            Object.entries(body.consents).map(([k, v]) => [CONSENT_KEYS[k], v]),
          ),
        },
        {
          channel: 'portal',
          source: 'clinic_qr_portal',
          actingContactId: contact.id,
          actingRelationship: body.relationship,
        },
      );
      await flagDuplicates(trx, org.id, patient.id, matches);
      await recordAudit(trx, {
        organizationId: org.id,
        action: 'patient.registered',
        entityType: 'patient',
        entityId: patient.id,
        ip: req.ip ?? null,
        requestId: req.id,
        metadata: { channel: 'portal', relationship: body.relationship, authorized },
      });
      return {
        id: patient.id,
        patientNumber: authorized ? patient.patient_number : null,
        fullName: patient.full_name,
        authorizationStatus: authorized ? 'authorized' : 'pending',
      };
    });
    res.status(201).json(result);
  });

  async function authorizedPatient(trx, org, contact, id) {
    if (!isUuid(id)) throw notFound('Patient not found');
    const link = await trx('contact_patient_links as l')
      .join('patients as p', 'p.id', 'l.patient_id')
      .where({
        'l.organization_id': org.id,
        'l.contact_id': contact.id,
        'l.patient_id': id,
        'l.authorization_status': 'authorized',
        'p.status': 'active',
      })
      .first('l.relationship');
    if (!link) throw notFound('Patient not found');
    return link;
  }

  router.post('/:slug/patients/:id/consents', portalAuth, async (req, res) => {
    const body = validate(
      z
        .object({
          whatsappService: z.boolean().optional(),
          smsService: z.boolean().optional(),
          marketing: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    const { org, contact } = req.portal;
    const patients = await withTenant(db, org.id, async (trx) => {
      const link = await authorizedPatient(trx, org, contact, req.params.id);
      const choices = Object.fromEntries(
        Object.entries(body).map(([k, v]) => [CONSENT_KEYS[k], v]),
      );
      await recordConsents(trx, org.id, req.params.id, choices, {
        channel: 'portal',
        source: 'clinic_qr_portal',
        actingContactId: contact.id,
        actingRelationship: link.relationship,
      });
      await recordAudit(trx, {
        organizationId: org.id,
        action: 'patient.consent_recorded',
        entityType: 'patient',
        entityId: req.params.id,
        ip: req.ip ?? null,
        requestId: req.id,
        metadata: { channel: 'portal', choices },
      });
      return linkedPatients(trx, org.id, contact.id);
    });
    res.json({ patients });
  });

  router.post('/:slug/patients/:id/privacy-requests', portalAuth, async (req, res) => {
    const body = validate(
      z
        .object({
          requestType: z.enum(['access', 'correction', 'erasure', 'grievance', 'nomination']),
          details: z.string().trim().min(3).max(2000),
        })
        .strict(),
      req.body,
    );
    const { org, contact } = req.portal;
    const row = await withTenant(db, org.id, async (trx) => {
      await authorizedPatient(trx, org, contact, req.params.id);
      const [created] = await trx('data_principal_requests')
        .insert({
          organization_id: org.id,
          patient_id: req.params.id,
          request_type: body.requestType,
          details: body.details,
          channel: 'portal',
        })
        .returning(['id', 'status']);
      await recordAudit(trx, {
        organizationId: org.id,
        action: 'privacy_request.created',
        entityType: 'data_principal_request',
        entityId: created.id,
        ip: req.ip ?? null,
        requestId: req.id,
        metadata: { channel: 'portal', requestType: body.requestType },
      });
      return created;
    });
    res.status(201).json(row);
  });

  return router;
}
