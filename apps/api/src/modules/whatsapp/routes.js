import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { withSystem, withTenant } from '../../core/db.js';
import { AppError } from '../../core/errors.js';
import { normalizeMobile } from '../../core/phone.js';
import { auditContext, recordAudit } from '../audit/index.js';
import { PERMISSIONS, requirePermission } from '../staff-access/permissions.js';
import { parseInboundMessages, verifyWebhookSignature } from '../../integrations/whatsapp/index.js';
import { handleMessage } from './bot.js';

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Processes stored inbound events. The webhook stores and acknowledges first (spec: acknowledge
 * quickly), then processing runs asynchronously. Events left "received" (e.g. after a restart) are
 * picked up by the periodic sweep.
 */
export function createWhatsAppProcessor({ db, config, whatsapp, logger }) {
  const inFlight = new Set();

  async function processEvent(organizationId, eventId) {
    let replies = [];
    let to = null;
    let phoneNumberId = null;
    try {
      await withTenant(db, organizationId, async (trx) => {
        const event = await trx('whatsapp_inbound_events')
          .where({ organization_id: organizationId, id: eventId, status: 'received' })
          .forUpdate()
          .skipLocked()
          .first();
        if (!event) return;
        const org = await trx('organizations')
          .where({ id: organizationId })
          .first('id', 'name', 'slug');
        const channel = await trx('whatsapp_channels')
          .where({ organization_id: organizationId, status: 'active' })
          .first('phone_number_id');
        if (!channel) {
          await trx('whatsapp_inbound_events')
            .where({ id: event.id })
            .update({ status: 'ignored', processed_at: trx.fn.now() });
          return;
        }
        replies = await handleMessage(trx, {
          org,
          phone: event.from_phone,
          text: event.text,
          messageId: event.provider_message_id,
          config,
        });
        to = event.from_phone;
        phoneNumberId = channel.phone_number_id;
        // The message text isn't needed once handled.
        await trx('whatsapp_inbound_events')
          .where({ id: event.id })
          .update({ status: 'processed', text: null, processed_at: trx.fn.now() });
      });
    } catch (err) {
      logger?.error({ err: err.message }, 'whatsapp event failed');
      await withTenant(db, organizationId, (trx) =>
        trx('whatsapp_inbound_events')
          .where({ id: eventId })
          .update({ status: 'failed', error: 'processing error', processed_at: trx.fn.now() }),
      ).catch(() => {});
      return;
    }
    for (const text of replies) {
      try {
        await whatsapp.sendText({ phoneNumberId, to, text });
      } catch (err) {
        logger?.warn({ err: err.message }, 'whatsapp reply failed');
      }
    }
  }

  const run = (organizationId, eventId) => {
    const p = processEvent(organizationId, eventId).finally(() => inFlight.delete(p));
    inFlight.add(p);
    return p;
  };

  return {
    enqueue: (organizationId, eventId) => {
      setImmediate(() => run(organizationId, eventId));
    },
    /** Waits until all queued work has finished (tests and graceful shutdown). */
    async drain() {
      await new Promise((r) => setImmediate(r));
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    },
    /** Retries events stuck in "received" for over a minute (pre-tenant sweep across hospitals). */
    async sweep() {
      const stuck = await withSystem(db, (trx) =>
        trx('whatsapp_inbound_events')
          .where({ status: 'received' })
          .where('received_at', '<', trx.raw("now() - interval '1 minute'"))
          .limit(50)
          .select('id', 'organization_id'),
      );
      for (const e of stuck) await run(e.organization_id, e.id);
    },
  };
}

export function whatsappWebhookRouter({ db, config, processor, logger }) {
  const router = Router();

  // Meta's subscription handshake.
  router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (
      mode === 'subscribe' &&
      config.WHATSAPP_VERIFY_TOKEN &&
      safeEqual(token ?? '', config.WHATSAPP_VERIFY_TOKEN)
    ) {
      return res.type('text/plain').send(String(challenge ?? ''));
    }
    res.sendStatus(403);
  });

  router.post('/', async (req, res) => {
    if (!config.WHATSAPP_APP_SECRET)
      throw new AppError(503, 'WHATSAPP_NOT_CONFIGURED', 'WhatsApp is not configured');
    if (
      !verifyWebhookSignature(
        config.WHATSAPP_APP_SECRET,
        req.rawBody,
        req.get('x-hub-signature-256'),
      )
    ) {
      throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid signature');
    }
    for (const m of parseInboundMessages(req.body)) {
      const phone = normalizeMobile(m.from);
      if (!phone) continue;
      // Pre-tenant: which hospital owns this WhatsApp number.
      const channel = await withSystem(db, (trx) =>
        trx('whatsapp_channels')
          .where({ phone_number_id: m.phoneNumberId })
          .first('organization_id'),
      );
      if (!channel) {
        logger?.warn('whatsapp message for an unregistered phone number id');
        continue;
      }
      const inserted = await withTenant(db, channel.organization_id, (trx) =>
        trx('whatsapp_inbound_events')
          .insert({
            organization_id: channel.organization_id,
            provider_message_id: m.id,
            from_phone: phone,
            text: m.text ? m.text.slice(0, 500) : null,
          })
          .onConflict('provider_message_id')
          .ignore()
          .returning('id'),
      );
      // Duplicate deliveries insert nothing and are not processed again.
      if (inserted[0]) processor.enqueue(channel.organization_id, inserted[0].id);
    }
    res.sendStatus(200);
  });

  return router;
}

/** Hospital settings: its WhatsApp number and recent notification outcomes. */
export function whatsappSettingsRouter({ db, config, whatsapp }) {
  const router = Router();
  const manage = requirePermission(PERMISSIONS.ORGANIZATION_MANAGE);

  router.get('/whatsapp', manage, async (req, res) => {
    const org = req.auth.organizationId;
    const row = await withTenant(db, org, (trx) =>
      trx('whatsapp_channels').where({ organization_id: org }).first(),
    );
    res.json({
      provider: whatsapp.provider,
      providerReady: whatsapp.provider !== 'none',
      appointmentTemplateSet: Boolean(config.WHATSAPP_APPOINTMENT_TEMPLATE),
      channel: row
        ? {
            phoneNumberId: row.phone_number_id,
            displayPhone: row.display_phone,
            status: row.status,
          }
        : null,
    });
  });

  router.put('/whatsapp', manage, async (req, res) => {
    const body = validate(
      z
        .object({
          phoneNumberId: z
            .string()
            .trim()
            .regex(/^\d{5,30}$/, 'Copy the Phone number ID from Meta (digits only)'),
          displayPhone: z.string().trim().max(30).nullable().optional(),
          status: z.enum(['active', 'paused']).default('active'),
        })
        .strict(),
      req.body,
    );
    const org = req.auth.organizationId;
    // The number ID must not already belong to another hospital (pre-tenant uniqueness check).
    const taken = await withSystem(db, (trx) =>
      trx('whatsapp_channels')
        .where({ phone_number_id: body.phoneNumberId })
        .whereNot({ organization_id: org })
        .first('id'),
    );
    if (taken)
      throw new AppError(
        409,
        'NUMBER_IN_USE',
        'This WhatsApp number is registered to another organization',
      );
    await withTenant(db, org, async (trx) => {
      await trx('whatsapp_channels')
        .insert({
          organization_id: org,
          phone_number_id: body.phoneNumberId,
          display_phone: body.displayPhone ?? null,
          status: body.status,
        })
        .onConflict('organization_id')
        .merge({
          phone_number_id: body.phoneNumberId,
          display_phone: body.displayPhone ?? null,
          status: body.status,
          updated_at: trx.fn.now(),
        });
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'whatsapp.channel_updated',
        entityType: 'whatsapp_channel',
        metadata: { status: body.status },
      });
    });
    res.json({
      phoneNumberId: body.phoneNumberId,
      displayPhone: body.displayPhone ?? null,
      status: body.status,
    });
  });

  router.get('/notifications', manage, async (req, res) => {
    const org = req.auth.organizationId;
    const rows = await withTenant(db, org, (trx) =>
      trx('notification_log as n')
        .leftJoin('patients as p', 'p.id', 'n.patient_id')
        .where('n.organization_id', org)
        .orderBy('n.created_at', 'desc')
        .limit(100)
        .select('n.*', 'p.full_name', 'p.patient_number'),
    );
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        purpose: r.purpose,
        channel: r.channel,
        status: r.status,
        reason: r.reason,
        patient: r.patient_id
          ? { id: r.patient_id, fullName: r.full_name, patientNumber: r.patient_number }
          : null,
        createdAt: r.created_at,
      })),
    });
  });

  return router;
}
