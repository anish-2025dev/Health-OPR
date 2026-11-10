/**
 * Phase 6: WhatsApp self-service and patient notifications.
 *
 * - whatsapp_channels maps a WhatsApp Business phone number ID (from Meta) to one hospital.
 * - whatsapp_inbound_events deduplicates webhook deliveries by the provider's message ID, so a
 *   repeated webhook never books twice. Only what the flow needs is kept (sender, text, status).
 * - whatsapp_conversations holds the short-lived booking conversation state per phone.
 * - notification_log records each outbound appointment notification (channel and status only, never
 *   message text).
 */

const CURRENT_ORG = "nullif(current_setting('app.current_organization_id', true), '')::uuid";
const BYPASS = "coalesce(current_setting('app.rls_bypass', true), '') = 'on'";
const NEW_TABLES = [
  'whatsapp_channels',
  'whatsapp_inbound_events',
  'whatsapp_conversations',
  'notification_log',
];

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE whatsapp_channels (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
      phone_number_id   text NOT NULL UNIQUE CHECK (phone_number_id ~ '^[0-9]{5,30}$'),
      display_phone     text CHECK (display_phone IS NULL OR length(display_phone) <= 30),
      status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE whatsapp_inbound_events (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      provider_message_id text NOT NULL UNIQUE,
      from_phone          text NOT NULL,
      text                text,
      status              text NOT NULL DEFAULT 'received'
                            CHECK (status IN ('received', 'processed', 'failed', 'ignored')),
      error               text,
      received_at         timestamptz NOT NULL DEFAULT now(),
      processed_at        timestamptz
    );
    CREATE INDEX whatsapp_inbound_pending_idx ON whatsapp_inbound_events (status, received_at);

    CREATE TABLE whatsapp_conversations (
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      phone_e164        text NOT NULL,
      state             text NOT NULL,
      data              jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at        timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, phone_e164)
    );

    CREATE TABLE notification_log (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      patient_id        uuid,
      appointment_id    uuid,
      purpose           text NOT NULL,
      channel           text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'none')),
      status            text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
      reason            text,
      created_at        timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX notification_log_org_idx ON notification_log (organization_id, created_at DESC);
  `);
  for (const table of NEW_TABLES) {
    await knex.raw(`
      ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON ${table}
        USING (${BYPASS} OR organization_id = ${CURRENT_ORG})
        WITH CHECK (${BYPASS} OR organization_id = ${CURRENT_ORG});
    `);
  }
}

export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS notification_log, whatsapp_conversations, whatsapp_inbound_events,
      whatsapp_channels;
  `);
}
