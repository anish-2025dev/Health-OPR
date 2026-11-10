import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createWhatsAppSender,
  parseInboundMessages,
  verifyWebhookSignature,
} from '../src/integrations/whatsapp/index.js';

describe('webhook signature', () => {
  it('accepts only the HMAC of the exact body', () => {
    const raw = Buffer.from('{"a":1}');
    const sig = `sha256=${createHmac('sha256', 's3cret').update(raw).digest('hex')}`;
    expect(verifyWebhookSignature('s3cret', raw, sig)).toBe(true);
    expect(verifyWebhookSignature('s3cret', Buffer.from('{"a":2}'), sig)).toBe(false);
    expect(verifyWebhookSignature('', raw, sig)).toBe(false);
    expect(verifyWebhookSignature('s3cret', raw, undefined)).toBe(false);
  });
});

describe('parseInboundMessages', () => {
  it('extracts text and button replies, ignores status updates', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '111' },
                messages: [
                  { id: 'm1', from: '919800000001', type: 'text', text: { body: 'hi' } },
                  {
                    id: 'm2',
                    from: '919800000001',
                    type: 'interactive',
                    interactive: { button_reply: { id: '1' } },
                  },
                ],
                statuses: [{ id: 's1', status: 'delivered' }],
              },
            },
          ],
        },
      ],
    };
    expect(parseInboundMessages(payload)).toEqual([
      { id: 'm1', from: '+919800000001', phoneNumberId: '111', text: 'hi' },
      { id: 'm2', from: '+919800000001', phoneNumberId: '111', text: '1' },
    ]);
    expect(parseInboundMessages({})).toEqual([]);
  });
});

describe('Meta sender', () => {
  it('posts to the configured Graph API version and number', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const wa = createWhatsAppSender(
      {
        WHATSAPP_PROVIDER: 'meta',
        WHATSAPP_ACCESS_TOKEN: 'tok',
        WHATSAPP_GRAPH_API_VERSION: 'v99.0',
        APP_ENV: 'production',
      },
      { fetchImpl },
    );
    await wa.sendText({ phoneNumberId: '555', to: '+919800000001', text: 'Hello' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v99.0/555/messages');
    expect(JSON.parse(init.body)).toMatchObject({
      messaging_product: 'whatsapp',
      to: '919800000001',
      type: 'text',
    });
  });

  it('is unavailable until configured; console is refused outside development', async () => {
    const off = createWhatsAppSender({ WHATSAPP_PROVIDER: 'meta', APP_ENV: 'production' });
    await expect(off.sendText({})).rejects.toThrow(/required/);
    expect(
      createWhatsAppSender({ WHATSAPP_PROVIDER: 'console', APP_ENV: 'production' }).provider,
    ).toBe('none');
  });
});
