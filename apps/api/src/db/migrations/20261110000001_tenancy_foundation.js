/**
 * Phase 2: tenancy foundation.
 *
 * Tables: organizations, branches, users, user_role_assignments, auth_sessions, audit_logs.
 *
 * Row-level security (defence in depth, see docs/architecture/tenancy-model.md):
 * - RLS is ENABLED and FORCED on every tenant table, so it applies to every role, including the
 *   table owner the app connects as. A query outside a tenant or system context sees no rows
 *   (fail closed).
 * - Tenant work runs inside withTenant(), which sets `app.current_organization_id` for that
 *   transaction only.
 * - The few system paths (login lookup, refresh-token lookup, organization bootstrap) run inside
 *   withSystem(), which sets `app.rls_bypass = on` for that transaction only.
 * - Superusers and BYPASSRLS roles skip RLS entirely, so the app must never connect as one. Local
 *   compose creates a normal role for the app; Neon's default owner role is not a superuser.
 */

const TENANT_TABLES = ['branches', 'users', 'user_role_assignments', 'auth_sessions', 'audit_logs'];

const CURRENT_ORG = "nullif(current_setting('app.current_organization_id', true), '')::uuid";
const BYPASS = "coalesce(current_setting('app.rls_bypass', true), '') = 'on'";

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE organizations (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
      legal_name  text,
      slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
      status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
      timezone    text NOT NULL DEFAULT 'Asia/Kolkata',
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE branches (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
      code             text NOT NULL CHECK (code ~ '^[A-Z0-9-]{2,20}$'),
      address          text,
      timezone         text NOT NULL DEFAULT 'Asia/Kolkata',
      status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, code),
      UNIQUE (organization_id, id)
    );

    CREATE TABLE users (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      email                 text NOT NULL CHECK (position('@' IN email) > 1),
      full_name             text NOT NULL CHECK (length(full_name) BETWEEN 2 AND 200),
      phone_e164            text CHECK (phone_e164 ~ '^\\+[1-9][0-9]{7,14}$'),
      password_hash         text,
      status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      must_change_password  boolean NOT NULL DEFAULT false,
      failed_login_count    integer NOT NULL DEFAULT 0,
      locked_until          timestamptz,
      last_login_at         timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id)
    );
    -- Staff email is globally unique so login needs no organization picker (pilot decision).
    CREATE UNIQUE INDEX users_email_unique ON users (lower(email));
    CREATE INDEX users_org_idx ON users (organization_id, status);

    CREATE TABLE user_role_assignments (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id  uuid NOT NULL,
      user_id          uuid NOT NULL,
      role_key         text NOT NULL CHECK (role_key IN (
                          'organization_owner', 'organization_admin', 'clinic_manager', 'receptionist',
                          'doctor', 'nurse', 'hr_manager', 'payroll_manager', 'department_manager',
                          'employee')),
      branch_id        uuid,
      created_at       timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, user_id) REFERENCES users (organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, branch_id) REFERENCES branches (organization_id, id) ON DELETE CASCADE,
      UNIQUE NULLS NOT DISTINCT (user_id, role_key, branch_id)
    );
    CREATE INDEX ura_org_user_idx ON user_role_assignments (organization_id, user_id);

    CREATE TABLE auth_sessions (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id  uuid NOT NULL,
      user_id          uuid NOT NULL,
      family_id        uuid NOT NULL,
      token_hash       text NOT NULL UNIQUE,
      expires_at       timestamptz NOT NULL,
      rotated_at       timestamptz,
      revoked_at       timestamptz,
      revoke_reason    text,
      user_agent       text,
      ip               inet,
      created_at       timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, user_id) REFERENCES users (organization_id, id) ON DELETE CASCADE
    );
    CREATE INDEX auth_sessions_family_idx ON auth_sessions (family_id);
    CREATE INDEX auth_sessions_user_idx ON auth_sessions (organization_id, user_id);

    CREATE TABLE audit_logs (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      actor_user_id    uuid,
      action           text NOT NULL,
      entity_type      text,
      entity_id        uuid,
      reason           text,
      metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
      ip               inet,
      request_id       text,
      created_at       timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX audit_logs_org_time_idx ON audit_logs (organization_id, created_at DESC, id DESC);

    -- Audit logs are append-only, even for the table owner.
    CREATE FUNCTION audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'audit_logs is append-only';
    END
    $$;
    CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
  `);

  // Row-level security, forced so it also applies to the table owner.
  await knex.raw(`
    ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON organizations
      USING (${BYPASS} OR id = ${CURRENT_ORG})
      WITH CHECK (${BYPASS} OR id = ${CURRENT_ORG});
  `);
  for (const table of TENANT_TABLES) {
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
    DROP TABLE IF EXISTS audit_logs, auth_sessions, user_role_assignments, users, branches, organizations CASCADE;
    DROP FUNCTION IF EXISTS audit_logs_immutable();
  `);
}
