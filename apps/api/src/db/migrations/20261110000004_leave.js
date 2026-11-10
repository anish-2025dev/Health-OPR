/**
 * Phase 9b: leave management.
 *
 * - organizations.leave_year_start_month: 1 = calendar year, 4 = April–March, etc.
 * - leave_types: company-defined types (paid/unpaid, quota, accrual, carry forward, half days, notice,
 *   max consecutive days, 1- or 2-level approval).
 * - leave_balance_adjustments: ledger of opening balances, manual adjustments and carry forward.
 * - leave_requests: applications and their approval trail. Approved leave is overlaid on attendance
 *   when attendance is read, so cancelling a leave never leaves stale attendance rows behind.
 */

const CURRENT_ORG = "nullif(current_setting('app.current_organization_id', true), '')::uuid";
const BYPASS = "coalesce(current_setting('app.rls_bypass', true), '') = 'on'";
const NEW_TABLES = ['leave_types', 'leave_balance_adjustments', 'leave_requests'];

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE organizations
      ADD COLUMN leave_year_start_month smallint NOT NULL DEFAULT 1
        CHECK (leave_year_start_month BETWEEN 1 AND 12);

    CREATE TABLE leave_types (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      name                  text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
      code                  text NOT NULL CHECK (code ~ '^[A-Z0-9]{1,10}$'),
      is_paid               boolean NOT NULL DEFAULT true,
      annual_quota          numeric(5, 1) NOT NULL DEFAULT 0 CHECK (annual_quota BETWEEN 0 AND 365),
      accrual               text NOT NULL DEFAULT 'yearly_upfront'
        CHECK (accrual IN ('yearly_upfront', 'monthly', 'none')),
      carry_forward_max     numeric(5, 1) NOT NULL DEFAULT 0 CHECK (carry_forward_max BETWEEN 0 AND 365),
      allow_half_day        boolean NOT NULL DEFAULT true,
      min_notice_days       integer NOT NULL DEFAULT 0 CHECK (min_notice_days BETWEEN 0 AND 90),
      max_consecutive_days  integer CHECK (max_consecutive_days IS NULL OR max_consecutive_days BETWEEN 1 AND 365),
      approval_levels       smallint NOT NULL DEFAULT 1 CHECK (approval_levels IN (1, 2)),
      status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, code)
    );

    CREATE TABLE leave_balance_adjustments (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id     uuid NOT NULL,
      employee_id         uuid NOT NULL,
      leave_type_id       uuid NOT NULL,
      leave_year          integer NOT NULL CHECK (leave_year BETWEEN 2000 AND 2100),
      days                numeric(5, 1) NOT NULL CHECK (days <> 0),
      kind                text NOT NULL CHECK (kind IN ('opening', 'adjustment', 'carry_forward')),
      reason              text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
      created_by_user_id  uuid,
      created_at          timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, employee_id) REFERENCES employees (organization_id, id),
      FOREIGN KEY (organization_id, leave_type_id) REFERENCES leave_types (organization_id, id)
    );
    CREATE INDEX leave_adjustments_lookup_idx
      ON leave_balance_adjustments (organization_id, employee_id, leave_year);
    CREATE UNIQUE INDEX leave_carry_forward_once
      ON leave_balance_adjustments (organization_id, employee_id, leave_type_id, leave_year)
      WHERE kind = 'carry_forward';

    CREATE TABLE leave_requests (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id     uuid NOT NULL,
      employee_id         uuid NOT NULL,
      leave_type_id       uuid NOT NULL,
      start_date          date NOT NULL,
      end_date            date NOT NULL,
      start_half          boolean NOT NULL DEFAULT false,
      end_half            boolean NOT NULL DEFAULT false,
      days                numeric(5, 1) NOT NULL CHECK (days > 0),
      leave_year          integer NOT NULL,
      reason              text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
      status              text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
      approval_level      smallint NOT NULL DEFAULT 1,
      level1_by_user_id   uuid,
      level1_at           timestamptz,
      decided_by_user_id  uuid,
      decided_at          timestamptz,
      decision_comment    text,
      cancelled_by_user_id uuid,
      created_at          timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, employee_id) REFERENCES employees (organization_id, id),
      FOREIGN KEY (organization_id, leave_type_id) REFERENCES leave_types (organization_id, id),
      CHECK (end_date >= start_date),
      CHECK (status <> 'rejected' OR decision_comment IS NOT NULL)
    );
    CREATE INDEX leave_requests_emp_idx ON leave_requests (organization_id, employee_id, start_date);
    CREATE INDEX leave_requests_status_idx ON leave_requests (organization_id, status, created_at DESC);
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
    DROP TABLE IF EXISTS leave_requests, leave_balance_adjustments, leave_types CASCADE;
    ALTER TABLE organizations DROP COLUMN IF EXISTS leave_year_start_month;
  `);
}
