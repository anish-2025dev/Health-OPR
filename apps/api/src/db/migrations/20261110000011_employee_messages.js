/**
 * Notification centre: HR, payroll and managers send messages to employees (payroll, performance,
 * leave, attendance or general). Employees read them in the app. An optional SMS only says that a new
 * message is waiting; it never contains the message itself.
 */
const CURRENT_ORG = "nullif(current_setting('app.current_organization_id', true), '')::uuid";
const BYPASS = "coalesce(current_setting('app.rls_bypass', true), '') = 'on'";
const NEW_TABLES = ['employee_messages', 'employee_message_recipients'];

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE employee_messages (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      sender_user_id    uuid,
      sender_label      text NOT NULL,
      category          text NOT NULL CHECK (category IN ('payroll', 'performance', 'leave', 'attendance', 'general')),
      title             text NOT NULL CHECK (length(title) BETWEEN 3 AND 150),
      body              text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
      audience_type     text NOT NULL CHECK (audience_type IN ('employees', 'team', 'department', 'branch', 'all', 'system')),
      audience_label    text NOT NULL,
      sms_alert         boolean NOT NULL DEFAULT false,
      created_at        timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id)
    );
    CREATE INDEX employee_messages_org_idx ON employee_messages (organization_id, created_at DESC);

    CREATE TABLE employee_message_recipients (
      organization_id   uuid NOT NULL,
      message_id        uuid NOT NULL,
      employee_id       uuid NOT NULL,
      read_at           timestamptz,
      sms_status        text CHECK (sms_status IS NULL OR sms_status IN ('sent', 'failed', 'skipped')),
      PRIMARY KEY (message_id, employee_id),
      FOREIGN KEY (organization_id, message_id) REFERENCES employee_messages (organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, employee_id) REFERENCES employees (organization_id, id)
    );
    CREATE INDEX employee_message_inbox_idx ON employee_message_recipients (organization_id, employee_id, read_at);
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
  await knex.raw('DROP TABLE IF EXISTS employee_message_recipients, employee_messages');
}
