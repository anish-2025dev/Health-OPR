import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../core/errors.js';
import { withTenant } from '../../core/db.js';
import { SmsNotConfiguredError } from '../../integrations/sms/index.js';
import { demoCodeAllowed } from '../../core/demo.js';

export const OTP_TTL_SECONDS = 300;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_COOLDOWN_SECONDS = 30;
export const OTP_MAX_PER_WINDOW = 5;
const WINDOW_MINUTES = 15;

const invalidCode = () =>
  new AppError(400, 'OTP_INVALID', 'The code is incorrect or has expired. Request a new code.');

/**
 * One-time codes for employee sign-in and attendance confirmation.
 * - 6 digits, 5-minute expiry, single use, at most 5 wrong attempts per code.
 * - Stored as HMAC-SHA256(APP_SECRET_KEY, challengeId:code), never in plain text, never logged.
 * - At most 5 codes per employee per purpose per 15 minutes, 30 seconds apart.
 */
export function createOtpService({ db, config, sms }) {
  const key = config.APP_SECRET_KEY || 'development-only-otp-key';
  const digest = (challengeId, code) =>
    createHmac('sha256', key).update(`${challengeId}:${code}`).digest();

  return {
    smsProvider: sms.provider,
    /** Demo deployment: codes for the demo hospital's fictional numbers are shown, not sent. */
    demoCodeAllowed: (organizationSlug, phone) => demoCodeAllowed(config, organizationSlug, phone),

    /** Creates a challenge and sends the code. Must run inside the tenant transaction `trx`. */
    async issue(
      trx,
      { organizationId, employeeId, purpose, mobile, metadata = {}, ip = null, demo = false },
    ) {
      const recent = await trx('otp_challenges')
        .where({ organization_id: organizationId, employee_id: employeeId, purpose })
        .where('created_at', '>', trx.raw(`now() - interval '${WINDOW_MINUTES} minutes'`))
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

      // Only the newest code is valid.
      await trx('otp_challenges')
        .where({ organization_id: organizationId, employee_id: employeeId, purpose })
        .whereNull('consumed_at')
        .update({ consumed_at: trx.fn.now() });

      const id = randomUUID();
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await trx('otp_challenges').insert({
        id,
        organization_id: organizationId,
        employee_id: employeeId,
        purpose,
        code_hash: digest(id, code).toString('hex'),
        expires_at: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
        metadata,
        ip,
      });

      if (demo) {
        return { challengeId: id, expiresInSeconds: OTP_TTL_SECONDS, demoCode: code };
      }
      try {
        await sms.sendOtp({ to: mobile, code, purpose });
      } catch (err) {
        // Throwing rolls back the challenge, so no unusable code is left behind.
        if (err instanceof SmsNotConfiguredError) {
          throw new AppError(
            503,
            'SMS_NOT_CONFIGURED',
            'SMS is not set up yet. Contact your administrator.',
          );
        }
        throw new AppError(502, 'SMS_SEND_FAILED', 'Could not send the SMS. Please try again.');
      }
      return { challengeId: id, expiresInSeconds: OTP_TTL_SECONDS };
    },

    /**
     * Verifies a code. On success the challenge is consumed and `onSuccess(trx, challenge)` runs in the
     * same transaction (so consuming the code and recording the result are atomic). A wrong code
     * increments the attempt counter in its own committed transaction before the error is thrown.
     */
    async verify({ organizationId, employeeId, purpose, challengeId, code }, onSuccess) {
      const outcome = await withTenant(db, organizationId, async (trx) => {
        const query = trx('otp_challenges')
          .where({ organization_id: organizationId, employee_id: employeeId, purpose })
          .whereNull('consumed_at')
          .orderBy('created_at', 'desc')
          .forUpdate()
          .first();
        if (challengeId) query.where('id', challengeId);
        const challenge = await query;

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
        const actual = digest(challenge.id, String(code ?? ''));
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
          await trx('otp_challenges').where({ id: challenge.id }).increment('attempts', 1);
          return { error: invalidCode() };
        }

        await trx('otp_challenges')
          .where({ id: challenge.id })
          .update({ consumed_at: trx.fn.now() });
        return { value: await onSuccess(trx, challenge) };
      });
      if (outcome.error) throw outcome.error;
      return outcome.value;
    },
  };
}
