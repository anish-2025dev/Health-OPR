/**
 * SMS provider adapters. Business code calls `sms.sendOtp({ to, code, purpose })` and never talks to a
 * vendor directly, so the provider can be swapped (spec: provider adapters).
 *
 * - console: development and tests only. Writes the OTP to the server console so a developer can sign
 *   in locally. Refused outside development/test, because OTPs must never be logged.
 * - msg91:   MSG91 Flow API (POST https://control.msg91.com/api/v5/flow) with a DLT-approved template.
 *            The message text lives in the MSG91 template; we only pass the code as a variable.
 * - memory:  tests; records sent messages so tests can read the code.
 */

export class SmsNotConfiguredError extends Error {
  constructor(message = 'SMS sending is not configured') {
    super(message);
    this.name = 'SmsNotConfiguredError';
  }
}

export function createMemorySms() {
  const sent = [];
  return {
    provider: 'memory',
    sent,
    lastCodeFor: (to) => [...sent].reverse().find((m) => m.to === to)?.code,
    async sendOtp({ to, code, purpose }) {
      sent.push({ to, code, purpose, at: new Date() });
    },
    async sendAppointment({ to, variables }) {
      sent.push({ to, purpose: 'appointment', variables, at: new Date() });
    },
    async sendMessageAlert({ to, variables }) {
      sent.push({ to, purpose: 'message_alert', variables, at: new Date() });
    },
  };
}

function createConsoleSms(logger) {
  return {
    provider: 'console',
    async sendOtp({ to, code, purpose }) {
      // Development only: printed to stdout for the developer, NOT through the structured logger.
      process.stdout.write(`\n[dev SMS] OTP for ${to} (${purpose}): ${code}\n\n`);
      logger?.info({ purpose, provider: 'console' }, 'development OTP printed to console');
    },
    async sendMessageAlert({ to, variables }) {
      process.stdout.write(`\n[dev SMS] new message alert to ${to}: ${variables.link}\n\n`);
    },
    async sendAppointment({ to, variables }) {
      process.stdout.write(
        `\n[dev SMS] appointment to ${to}: ${Object.values(variables).join(' | ')}\n\n`,
      );
    },
  };
}

function createMsg91Sms(config, fetchImpl = globalThis.fetch) {
  const flow = async (templateId, recipient) => {
    const res = await fetchImpl('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authkey: config.MSG91_AUTH_KEY,
      },
      body: JSON.stringify({ template_id: templateId, short_url: '0', recipients: [recipient] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.type === 'error') {
      throw new Error(
        `MSG91 send failed (HTTP ${res.status}${body.message ? `: ${body.message}` : ''})`,
      );
    }
  };
  return {
    provider: 'msg91',
    async sendMessageAlert({ to, variables }) {
      if (!config.MSG91_MESSAGE_ALERT_TEMPLATE_ID) {
        throw new SmsNotConfiguredError('MSG91_MESSAGE_ALERT_TEMPLATE_ID is not set');
      }
      const names = config.MSG91_MESSAGE_ALERT_VARIABLES.split(',');
      await flow(config.MSG91_MESSAGE_ALERT_TEMPLATE_ID, {
        mobiles: to.replace(/^\+/, ''),
        [names[0]]: String(variables.org),
        [names[1]]: String(variables.link),
      });
    },
    async sendAppointment({ to, variables }) {
      if (!config.MSG91_APPOINTMENT_TEMPLATE_ID) {
        throw new SmsNotConfiguredError('MSG91_APPOINTMENT_TEMPLATE_ID is not set');
      }
      const names = config.MSG91_APPOINTMENT_VARIABLES.split(',');
      const values = [variables.token, variables.date, variables.time, variables.link];
      await flow(config.MSG91_APPOINTMENT_TEMPLATE_ID, {
        mobiles: to.replace(/^\+/, ''),
        ...Object.fromEntries(names.map((n, k) => [n, String(values[k])])),
      });
    },
    async sendOtp({ to, code }) {
      const res = await fetchImpl('https://control.msg91.com/api/v5/flow', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authkey: config.MSG91_AUTH_KEY,
        },
        body: JSON.stringify({
          template_id: config.MSG91_OTP_TEMPLATE_ID,
          short_url: '0',
          // MSG91 expects the number with country code and without '+'.
          recipients: [{ mobiles: to.replace(/^\+/, ''), [config.MSG91_OTP_VARIABLE]: code }],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.type === 'error') {
        // Never include the code or the full number in errors.
        throw new Error(
          `MSG91 send failed (HTTP ${res.status}${body.message ? `: ${body.message}` : ''})`,
        );
      }
    },
  };
}

export function createSmsSender(config, { logger, fetchImpl } = {}) {
  const devLike = config.APP_ENV === 'development' || config.APP_ENV === 'test';
  switch (config.SMS_PROVIDER) {
    case 'msg91':
      if (!config.MSG91_AUTH_KEY || !config.MSG91_OTP_TEMPLATE_ID) {
        return notConfigured('MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID are required for SMS');
      }
      return createMsg91Sms(config, fetchImpl);
    case 'console':
      if (!devLike) return notConfigured('The console SMS provider is only allowed in development');
      return createConsoleSms(logger);
    default:
      return notConfigured('SMS_PROVIDER is not set');
  }
}

function notConfigured(reason) {
  return {
    provider: 'none',
    reason,
    async sendOtp() {
      throw new SmsNotConfiguredError(reason);
    },
    async sendAppointment() {
      throw new SmsNotConfiguredError(reason);
    },
    async sendMessageAlert() {
      throw new SmsNotConfiguredError(reason);
    },
  };
}
