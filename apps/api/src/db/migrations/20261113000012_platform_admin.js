/**
 * Platform administration (ADR 0011): the operator's own team onboards hospitals.
 *
 * - platform_admins / platform_sessions: a separate login for the operator's staff. These accounts
 *   belong to no hospital, and a platform token can never be used as a hospital token (or the reverse).
 * - platform_audit_logs: every platform action (create hospital, send invite, suspend, reactivate).
 * - user_invites: one-time links that let a new hospital owner (or any user) set their own password.
 *   Only a SHA-256 hash of the token is stored. Tenant-owned, so RLS applies; the token lookup is a
 *   pre-tenant step, like login.
 */
const CURRENT_ORG = "nullif(current_setting('app.current_organization_id', true), '')::uuid";
const BYPASS = "coalesce(current_setting('app.rls_bypass', true), '') = 'on'";

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE platform_admins (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email                 text NOT NULL CHECK (position('@' IN email) > 1),
      full_name             text NOT NULL CHECK (length(full_name) BETWEEN 2 AND 200),
      password_hash         text,
      status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      must_change_password  boolean NOT NULL DEFAULT true,
      failed_login_count    integer NOT NULL DEFAULT 0,
      locked_until          timestamptz,
      last_login_at         timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX platform_admins_email_unique ON platform_admins (lower(email));

    CREATE TABLE platform_sessions (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id            uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
      refresh_token_hash  text NOT NULL UNIQUE,
      expires_at          timestamptz NOT NULL,
      revoked_at          timestamptz,
      ip                  inet,
      user_agent          text,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX platform_sessions_admin_idx ON platform_sessions (admin_id);

    CREATE TABLE platform_audit_logs (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id          uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
      action            text NOT NULL,
      organization_id   uuid REFERENCES organizations(id) ON DELETE SET NULL,
      reason            text,
      metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
      ip                inet,
      created_at        timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX platform_audit_created_idx ON platform_audit_logs (created_at DESC);

    CREATE TABLE user_invites (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id               uuid NOT NULL,
      token_hash            text NOT NULL UNIQUE,
      expires_at            timestamptz NOT NULL,
      used_at               timestamptz,
      revoked_at            timestamptz,
      created_by_platform_admin_id uuid,
      created_by_user_id    uuid,
      created_at            timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, user_id) REFERENCES users (organization_id, id) ON DELETE CASCADE
    );
    CREATE INDEX user_invites_user_idx ON user_invites (organization_id, user_id);

    ALTER TABLE user_invites ENABLE ROW LEVEL SECURITY;
    ALTER TABLE user_invites FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON user_invites
      USING (${BYPASS} OR organization_id = ${CURRENT_ORG})
      WITH CHECK (${BYPASS} OR organization_id = ${CURRENT_ORG});
  `);
}

export async function down(knex) {
  await knex.raw(
    'DROP TABLE IF EXISTS user_invites, platform_audit_logs, platform_sessions, platform_admins',
  );
}
