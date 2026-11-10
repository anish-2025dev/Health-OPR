import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * WhatsApp provider adapters. Business code calls sendText / sendTemplate and never talks to a vendor
 * directly (spec: provider adapters).
 *
 * - meta:    WhatsApp Business Platform Cloud API
 *            (POST https://graph.facebook.com/<version>/<phone-number-id>/messages).
 * - console: development only; prints messages to stdout.
 * - memory:  tests; records messages.
 *
 * Phone numbers are sent without '+', as the Cloud API expects. Message text never includes medical
 * details (spec).
 */
export class WhatsAppNotConfiguredError extends Error {
  constructor(message = 'WhatsApp is not configured') {
    super(message);
    this.name = 'WhatsAppNotConfiguredError';
  }
}

export function createMemoryWhatsApp() {
  const sent = [];
  return {
    provider: 'memory',
    sent,
    async sendText(msg) {
      sent.push({ type: 'text', ...msg });
    },
    async sendTemplate(msg) {
      sent.push({ type: 'template', ...msg });
    },
    lastTo: (to) => [...sent].reverse().find((m) => m.to === to),
    clear: () => sent.splice(0),
  };
}

function createMetaWhatsApp(config, fetchImpl = globalThis.fetch) {
  const post = async (phoneNumberId, payload) => {
    const res = await fetchImpl(
      `https://graph.facebook.com/${config.WHATSAPP_GRAPH_API_VERSION}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // Never include the recipient or message in errors.
      throw new Error(
        `WhatsApp send failed (HTTP ${res.status}${body.error?.code ? `, code ${body.error.code}` : ''})`,
      );
    }
  };
  return {
    provider: 'meta',
    sendText: ({ phoneNumberId, to, text }) =>
      post(phoneNumberId, {
        to: to.replace(/^\+/, ''),
        type: 'text',
        text: { body: text, preview_url: true },
      }),
    sendTemplate: ({ phoneNumberId, to, template, language, params }) =>
      post(phoneNumberId, {
        to: to.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: template,
          language: { code: language },
          components: [
            {
              type: 'body',
              parameters: params.map((text) => ({ type: 'text', text: String(text) })),
            },
          ],
        },
      }),
  };
}

function createConsoleWhatsApp() {
  const print = (label, to, body) =>
    process.stdout.write(`\n[dev WhatsApp] ${label} to ${to}:\n${body}\n\n`);
  return {
    provider: 'console',
    async sendText({ to, text }) {
      print('message', to, text);
    },
    async sendTemplate({ to, template, params }) {
      print(`template ${template}`, to, params.join(' | '));
    },
  };
}

function notConfigured(reason) {
  const fail = async () => {
    throw new WhatsAppNotConfiguredError(reason);
  };
  return { provider: 'none', reason, sendText: fail, sendTemplate: fail };
}

export function createWhatsAppSender(config, { fetchImpl } = {}) {
  const devLike = config.APP_ENV === 'development' || config.APP_ENV === 'test';
  switch (config.WHATSAPP_PROVIDER) {
    case 'meta':
      if (!config.WHATSAPP_ACCESS_TOKEN || !config.WHATSAPP_GRAPH_API_VERSION) {
        return notConfigured('WHATSAPP_ACCESS_TOKEN and WHATSAPP_GRAPH_API_VERSION are required');
      }
      return createMetaWhatsApp(config, fetchImpl);
    case 'console':
      if (!devLike)
        return notConfigured('The console WhatsApp provider is only allowed in development');
      return createConsoleWhatsApp();
    default:
      return notConfigured('WHATSAPP_PROVIDER is not set');
  }
}

/** Verifies Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with the app secret). */
export function verifyWebhookSignature(appSecret, rawBody, header) {
  if (!appSecret || !rawBody || typeof header !== 'string' || !header.startsWith('sha256='))
    return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice(7), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Extracts inbound text messages from a Cloud API webhook payload. Status updates are ignored. */
export function parseInboundMessages(payload) {
  const out = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      for (const m of value?.messages ?? []) {
        if (!m?.id || !m?.from || !phoneNumberId) continue;
        const text =
          m.type === 'text'
            ? m.text?.body
            : m.type === 'interactive'
              ? (m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id)
              : m.type === 'button'
                ? m.button?.text
                : null;
        out.push({
          id: m.id,
          from: `+${String(m.from).replace(/^\+/, '')}`,
          phoneNumberId: String(phoneNumberId),
          text: text ?? null,
        });
      }
    }
  }
  return out;
}
