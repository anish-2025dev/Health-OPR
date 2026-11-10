/**
 * Phase 9a: attendance.
 *
 * - users.email becomes optional: employees sign in with mobile + OTP and get an employee-only user
 *   account with no email and no password.
 * - otp_challenges: hashed one-time codes for employee sign-in and attendance confirmation.
 * - attendance_policies: one per organization for the pilot (full/half-day hours, late rules, OT).
 * - attendance_punches: every accepted punch (never deleted; corrections add rows or void).
 * - attendance_days: one computed row per employee per work date, with the policy snapshot used.
 * - attendance_regularizations: employee correction requests and their decisions.
 *
 * Every new table has RLS enabled and FORCED (same policy as earlier phases).
 */

const CURRENT_ORG = "nullif(current_setting('app.current_organization_id', true), '')::uuid";
const BYPASS = "coalesce(current_setting('app.rls_bypass', true), '') = 'on'";
const NEW_TABLES = [
  'otp_challenges',
  'attendance_policies',
  'attendance_punches',
  'attendance_days',
  'attendance_regularizations',
];

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
    ALTER TABLE users ADD CONSTRAINT users_password_needs_email
      CHECK (password_hash IS NULL OR email IS NOT NULL);

    CREATE TABLE otp_challenges (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      employee_id      uuid NOT NULL,
      purpose          text NOT NULL CHECK (purpose IN ('employee_login', 'attendance')),
      code_hash        text NOT NULL,
      expires_at       timestamptz NOT NULL,
      attempts         integer NOT NULL DEFAULT 0,
      consumed_at      timestamptz,
      metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
      ip               inet,
      created_at       timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, employee_id) REFERENCES employees (organization_id, id) ON DELETE CASCADE
    );
    CREATE INDEX otp_challenges_lookup_idx
      ON otp_challenges (organization_id, employee_id, purpose, created_at DESC);

    CREATE TABLE attendance_policies (
      id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id           uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
      full_day_minutes          integer NOT NULL DEFAULT 540 CHECK (full_day_minutes BETWEEN 60 AND 1440),
      half_day_minutes          integer NOT NULL DEFAULT 300 CHECK (half_day_minutes BETWEEN 30 AND 1440),
      below_half_day_status     text NOT NULL DEFAULT 'absent'
        CHECK (below_half_day_status IN ('absent', 'reduced_hours')),
      late_grace_minutes        integer NOT NULL DEFAULT 15 CHECK (late_grace_minutes BETWEEN 0 AND 240),
      late_free_per_month       integer NOT NULL DEFAULT 3 CHECK (late_free_per_month BETWEEN 0 AND 31),
      late_penalty_mode         text NOT NULL DEFAULT 'none'
        CHECK (late_penalty_mode IN ('none', 'fixed_amount', 'half_day_per_n', 'full_day_per_n')),
      late_penalty_amount       numeric(12, 2) CHECK (late_penalty_amount IS NULL OR late_penalty_amount >= 0),
      late_penalty_every_n      integer CHECK (late_penalty_every_n IS NULL OR late_penalty_every_n BETWEEN 1 AND 31),
      overtime_after_minutes    integer NOT NULL DEFAULT 30 CHECK (overtime_after_minutes BETWEEN 0 AND 600),
      min_punch_gap_seconds     integer NOT NULL DEFAULT 60 CHECK (min_punch_gap_seconds BETWEEN 0 AND 3600),
      updated_by_user_id        uuid,
      created_at                timestamptz NOT NULL DEFAULT now(),
      updated_at                timestamptz NOT NULL DEFAULT now(),
      CHECK (half_day_minutes <= full_day_minutes),
      CHECK (late_penalty_mode <> 'fixed_amount' OR late_penalty_amount IS NOT NULL),
      CHECK (late_penalty_mode NOT IN ('half_day_per_n', 'full_day_per_n') OR late_penalty_every_n IS NOT NULL)
    );

    CREATE TABLE attendance_punches (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id     uuid NOT NULL,
      employee_id         uuid NOT NULL,
      branch_id           uuid NOT NULL,
      work_date           date NOT NULL,
      punched_at          timestamptz NOT NULL,
      punch_type          text NOT NULL CHECK (punch_type IN ('in', 'out')),
      source              text NOT NULL CHECK (source IN ('app_otp_geo', 'manual', 'regularization', 'import')),
      distance_m          numeric(8, 1),
      accuracy_m          numeric(8, 1),
      otp_challenge_id    uuid,
      created_by_user_id  uuid,
      reason              text,
      voided_at           timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, employee_id) REFERENCES employees (organization_id, id),
      FOREIGN KEY (organization_id, branch_id) REFERENCES branches (organization_id, id),
      CHECK (source = 'app_otp_geo' OR reason IS NOT NULL)
    );
    CREATE INDEX attendance_punches_emp_idx ON attendance_punches (organization_id, employee_id, punched_at DESC);

    CREATE TABLE attendance_days (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id     uuid NOT NULL,
      employee_id         uuid NOT NULL,
      branch_id           uuid NOT NULL,
      work_date           date NOT NULL,
      first_in            timestamptz,
      last_out            timestamptz,
      shift_start         time,
      shift_end           time,
      break_minutes       integer NOT NULL DEFAULT 0,
      worked_minutes      integer NOT NULL DEFAULT 0,
      late_minutes        integer NOT NULL DEFAULT 0,
      is_late             boolean NOT NULL DEFAULT false,
      overtime_minutes    integer NOT NULL DEFAULT 0,
      is_holiday          boolean NOT NULL DEFAULT false,
      is_week_off         boolean NOT NULL DEFAULT false,
      status              text NOT NULL CHECK (status IN (
                            'checked_in', 'incomplete', 'present', 'half_day', 'reduced_hours', 'absent',
                            'week_off', 'holiday', 'leave')),
      status_source       text NOT NULL DEFAULT 'computed'
        CHECK (status_source IN ('computed', 'manual', 'regularization')),
      manual_reason       text,
      manual_by_user_id   uuid,
      policy_snapshot     jsonb NOT NULL DEFAULT '{}'::jsonb,
      locked_at           timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, employee_id) REFERENCES employees (organization_id, id),
      FOREIGN KEY (organization_id, branch_id) REFERENCES branches (organization_id, id),
      UNIQUE (organization_id, employee_id, work_date),
      CHECK (status_source = 'computed' OR manual_reason IS NOT NULL)
    );
    CREATE INDEX attendance_days_date_idx ON attendance_days (organization_id, work_date, branch_id);

    CREATE TABLE attendance_regularizations (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id     uuid NOT NULL,
      employee_id         uuid NOT NULL,
      work_date           date NOT NULL,
      requested_in        time,
      requested_out       time,
      requested_status    text CHECK (requested_status IS NULL OR requested_status IN (
                            'present', 'half_day', 'reduced_hours', 'absent', 'week_off', 'holiday')),
      reason              text NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
      status              text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
      decided_by_user_id  uuid,
      decided_at          timestamptz,
      decision_comment    text,
      created_at          timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, employee_id) REFERENCES employees (organization_id, id),
      CHECK (requested_in IS NOT NULL OR requested_out IS NOT NULL OR requested_status IS NOT NULL),
      CHECK (status <> 'rejected' OR decision_comment IS NOT NULL)
    );
    CREATE UNIQUE INDEX attendance_regularizations_one_pending
      ON attendance_regularizations (organization_id, employee_id, work_date) WHERE status = 'pending';
    CREATE INDEX attendance_regularizations_status_idx
      ON attendance_regularizations (organization_id, status, created_at DESC);
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
    DROP TABLE IF EXISTS attendance_regularizations, attendance_days, attendance_punches,
      attendance_policies, otp_challenges CASCADE;
    DELETE FROM user_role_assignments WHERE user_id IN (SELECT id FROM users WHERE email IS NULL);
    UPDATE employees SET user_id = NULL WHERE user_id IN (SELECT id FROM users WHERE email IS NULL);
    DELETE FROM users WHERE email IS NULL;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_password_needs_email;
    ALTER TABLE users ALTER COLUMN email SET NOT NULL;
  `);
}
