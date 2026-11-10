/**
 * Patient accounts for the patient website (ADR 0009).
 *
 * A patient account is a platform-level sign-in identity: one verified phone number. It is NOT a
 * patient record. Patient records stay inside each hospital's tenant data. An account sees a
 * hospital only after the person joins it with the hospital's code (or its QR link), which links
 * the account to that hospital's verified contact. Hospitals never see each other's records through
 * this table.
 *
 * These tables are not tenant-owned (like `organizations`), so they have no organization RLS
 * policy. Every query is keyed by the signed-in account id. Tenant data reached through a membership
 * always runs inside withTenant() for that hospital.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE patient_accounts (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      phone_e164      text NOT NULL UNIQUE CHECK (phone_e164 ~ '^\\+[1-9][0-9]{7,14}$'),
      status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at      timestamptz NOT NULL DEFAULT now(),
      last_login_at   timestamptz
    );

    CREATE TABLE patient_account_otps (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      phone_e164      text NOT NULL,
      code_hash       text NOT NULL,
      expires_at      timestamptz NOT NULL,
      attempts        integer NOT NULL DEFAULT 0,
      consumed_at     timestamptz,
      ip              inet,
      created_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX patient_account_otps_idx ON patient_account_otps (phone_e164, created_at DESC);

    CREATE TABLE patient_account_sessions (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id          uuid NOT NULL REFERENCES patient_accounts(id) ON DELETE CASCADE,
      refresh_token_hash  text NOT NULL UNIQUE,
      expires_at          timestamptz NOT NULL,
      revoked_at          timestamptz,
      user_agent          text,
      ip                  inet,
      created_at          timestamptz NOT NULL DEFAULT now(),
      last_used_at        timestamptz
    );
    CREATE INDEX patient_account_sessions_account_idx ON patient_account_sessions (account_id);

    CREATE TABLE patient_account_clinics (
      account_id        uuid NOT NULL REFERENCES patient_accounts(id) ON DELETE CASCADE,
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      contact_id        uuid NOT NULL,
      joined_at         timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, organization_id)
    );
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS patient_account_clinics, patient_account_sessions, patient_account_otps,
      patient_accounts;
  `);
}
