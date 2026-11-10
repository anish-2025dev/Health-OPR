/**
 * Phase 10: payroll foundation.
 *
 * - payroll_settings: day-rate basis chosen by the company, and how attendance counts as loss of pay.
 * - salary_components / salary_structures / salary_structure_lines: effective-dated pay per employee.
 * - pay_policies: company-defined deductions and earnings (fixed, % of a component, or per unit of an
 *   attendance metric), one-time or in instalments, for everyone or selected employees.
 * - payroll_runs / payroll_items / payroll_adjustments: monthly runs. Each item stores the complete
 *   calculation snapshot (inputs and lines) so it can be reproduced exactly.
 *
 * Approved payroll is immutable: database triggers reject changes to amounts or snapshots of an approved
 * run's items, and any change of an approved run except recording that it was paid.
 * Money is numeric(12,2); the engine computes in integer paise.
 */

const CURRENT_ORG = "nullif(current_setting('app.current_organization_id', true), '')::uuid";
const BYPASS = "coalesce(current_setting('app.rls_bypass', true), '') = 'on'";
const NEW_TABLES = [
  'payroll_settings',
  'salary_components',
  'salary_structures',
  'salary_structure_lines',
  'pay_policies',
  'payroll_runs',
  'payroll_items',
  'payroll_adjustments',
];

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE payroll_settings (
      organization_id         uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      day_rate_basis          text NOT NULL DEFAULT 'calendar_days'
        CHECK (day_rate_basis IN ('calendar_days', 'working_days', 'fixed_days')),
      fixed_days              integer CHECK (fixed_days IS NULL OR fixed_days BETWEEN 20 AND 31),
      incomplete_day_lop      numeric(3, 2) NOT NULL DEFAULT 1 CHECK (incomplete_day_lop IN (0, 0.5, 1)),
      reduced_hours_lop       numeric(3, 2) NOT NULL DEFAULT 0.5 CHECK (reduced_hours_lop IN (0, 0.5, 1)),
      updated_by_user_id      uuid,
      updated_at              timestamptz NOT NULL DEFAULT now(),
      CHECK (day_rate_basis <> 'fixed_days' OR fixed_days IS NOT NULL)
    );

    CREATE TABLE salary_components (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      name                text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
      code                text NOT NULL CHECK (code ~ '^[A-Z0-9_]{1,16}$'),
      kind                text NOT NULL CHECK (kind IN ('earning', 'deduction')),
      calc                text NOT NULL DEFAULT 'fixed' CHECK (calc IN ('fixed', 'percent_of_component')),
      percent             numeric(7, 4) CHECK (percent IS NULL OR percent BETWEEN 0 AND 1000),
      base_component_id   uuid,
      include_in_day_rate boolean NOT NULL DEFAULT true,
      display_order       integer NOT NULL DEFAULT 100,
      status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, code),
      FOREIGN KEY (organization_id, base_component_id) REFERENCES salary_components (organization_id, id),
      CHECK (calc <> 'percent_of_component' OR (percent IS NOT NULL AND base_component_id IS NOT NULL))
    );

    CREATE TABLE salary_structures (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id     uuid NOT NULL,
      employee_id         uuid NOT NULL,
      effective_from      date NOT NULL,
      effective_to        date,
      currency            text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
      note                text,
      created_by_user_id  uuid,
      created_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      FOREIGN KEY (organization_id, employee_id) REFERENCES employees (organization_id, id),
      CHECK (effective_to IS NULL OR effective_to >= effective_from)
    );
    CREATE UNIQUE INDEX salary_structures_one_start ON salary_structures (organization_id, employee_id, effective_from);

    CREATE TABLE salary_structure_lines (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id     uuid NOT NULL,
      structure_id        uuid NOT NULL,
      component_id        uuid NOT NULL,
      amount              numeric(12, 2) NOT NULL CHECK (amount >= 0),
      FOREIGN KEY (organization_id, structure_id) REFERENCES salary_structures (organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, component_id) REFERENCES salary_components (organization_id, id),
      UNIQUE (structure_id, component_id)
    );

    CREATE TABLE pay_policies (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      name                text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
      code                text NOT NULL CHECK (code ~ '^[A-Z0-9_]{1,16}$'),
      kind                text NOT NULL CHECK (kind IN ('earning', 'deduction')),
      calc                text NOT NULL CHECK (calc IN ('fixed', 'percent_of_component', 'per_unit')),
      amount              numeric(12, 2) CHECK (amount IS NULL OR amount >= 0),
      percent             numeric(7, 4) CHECK (percent IS NULL OR percent BETWEEN 0 AND 1000),
      base_component_id   uuid,
      unit_metric         text CHECK (unit_metric IS NULL OR unit_metric IN (
                            'lop_days', 'absent_days', 'half_days', 'late_beyond_free',
                            'reduced_hour_days', 'overtime_hours', 'incomplete_days')),
      unit_rate           text CHECK (unit_rate IS NULL OR unit_rate IN ('fixed_amount', 'day_rate', 'hourly_rate')),
      multiplier          numeric(6, 3) NOT NULL DEFAULT 1 CHECK (multiplier > 0 AND multiplier <= 10),
      frequency           text NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly', 'one_time', 'installments')),
      installments        integer CHECK (installments IS NULL OR installments BETWEEN 1 AND 120),
      applies_to          text NOT NULL DEFAULT 'all' CHECK (applies_to IN ('all', 'branch', 'department', 'employees')),
      applies_to_ids      uuid[] NOT NULL DEFAULT '{}',
      effective_from      date NOT NULL,
      effective_to        date,
      status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, code),
      FOREIGN KEY (organization_id, base_component_id) REFERENCES salary_components (organization_id, id),
      CHECK (calc <> 'fixed' OR amount IS NOT NULL),
      CHECK (calc <> 'percent_of_component' OR (percent IS NOT NULL AND base_component_id IS NOT NULL)),
      CHECK (calc <> 'per_unit' OR (unit_metric IS NOT NULL AND unit_rate IS NOT NULL)),
      CHECK (unit_rate IS DISTINCT FROM 'fixed_amount' OR amount IS NOT NULL),
      CHECK (frequency <> 'installments' OR installments IS NOT NULL),
      CHECK (effective_to IS NULL OR effective_to >= effective_from)
    );

    CREATE TABLE payroll_runs (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      branch_id           uuid,
      period_start        date NOT NULL,
      period_end          date NOT NULL,
      status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'calculated', 'approved')),
      settings_snapshot   jsonb NOT NULL DEFAULT '{}'::jsonb,
      warnings            jsonb NOT NULL DEFAULT '[]'::jsonb,
      engine_version      text,
      created_by_user_id  uuid,
      calculated_by_user_id uuid,
      calculated_at       timestamptz,
      approved_by_user_id uuid,
      approved_at         timestamptz,
      notes               text,
      created_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      FOREIGN KEY (organization_id, branch_id) REFERENCES branches (organization_id, id),
      UNIQUE NULLS NOT DISTINCT (organization_id, branch_id, period_start),
      CHECK (period_end >= period_start)
    );

    CREATE TABLE payroll_items (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id      uuid NOT NULL,
      payroll_run_id       uuid NOT NULL,
      employee_id          uuid NOT NULL,
      gross_earnings       numeric(12, 2) NOT NULL,
      total_deductions     numeric(12, 2) NOT NULL,
      net_pay              numeric(12, 2) NOT NULL,
      calculation_snapshot jsonb NOT NULL,
      payment_status       text NOT NULL DEFAULT 'pending'
        CHECK (payment_status IN ('pending', 'paid', 'failed', 'on_hold')),
      paid_at              timestamptz,
      payment_reference    text,
      payment_updated_by_user_id uuid,
      created_at           timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, payroll_run_id) REFERENCES payroll_runs (organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, employee_id) REFERENCES employees (organization_id, id),
      UNIQUE (payroll_run_id, employee_id)
    );
    CREATE INDEX payroll_items_employee_idx ON payroll_items (organization_id, employee_id);

    CREATE TABLE payroll_adjustments (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id     uuid NOT NULL,
      payroll_run_id      uuid NOT NULL,
      employee_id         uuid NOT NULL,
      kind                text NOT NULL CHECK (kind IN ('earning', 'deduction')),
      label               text NOT NULL CHECK (length(label) BETWEEN 2 AND 80),
      amount              numeric(12, 2) NOT NULL CHECK (amount > 0),
      reason              text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
      created_by_user_id  uuid,
      created_at          timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, payroll_run_id) REFERENCES payroll_runs (organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, employee_id) REFERENCES employees (organization_id, id)
    );

    -- Approved payroll is immutable (spec: corrections use adjustments in a later run).
    CREATE FUNCTION payroll_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'approved' THEN RAISE EXCEPTION 'approved payroll is immutable'; END IF;
        RETURN OLD;
      END IF;
      IF OLD.status = 'approved' THEN
        RAISE EXCEPTION 'approved payroll is immutable';
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER payroll_runs_immutable BEFORE UPDATE OR DELETE ON payroll_runs
      FOR EACH ROW EXECUTE FUNCTION payroll_runs_guard();

    CREATE FUNCTION payroll_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE run_status text;
    BEGIN
      SELECT status INTO run_status FROM payroll_runs
        WHERE id = COALESCE(OLD.payroll_run_id, NEW.payroll_run_id);
      IF run_status = 'approved' THEN
        IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'approved payroll is immutable'; END IF;
        IF NEW.gross_earnings IS DISTINCT FROM OLD.gross_earnings
          OR NEW.total_deductions IS DISTINCT FROM OLD.total_deductions
          OR NEW.net_pay IS DISTINCT FROM OLD.net_pay
          OR NEW.calculation_snapshot IS DISTINCT FROM OLD.calculation_snapshot
          OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
          OR NEW.payroll_run_id IS DISTINCT FROM OLD.payroll_run_id THEN
          RAISE EXCEPTION 'approved payroll is immutable';
        END IF;
      END IF;
      RETURN COALESCE(NEW, OLD);
    END
    $$;
    CREATE TRIGGER payroll_items_immutable BEFORE INSERT OR UPDATE OR DELETE ON payroll_items
      FOR EACH ROW EXECUTE FUNCTION payroll_items_guard();

    CREATE FUNCTION payroll_adjustments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE run_status text;
    BEGIN
      SELECT status INTO run_status FROM payroll_runs
        WHERE id = COALESCE(OLD.payroll_run_id, NEW.payroll_run_id);
      IF run_status = 'approved' THEN RAISE EXCEPTION 'approved payroll is immutable'; END IF;
      RETURN COALESCE(NEW, OLD);
    END
    $$;
    CREATE TRIGGER payroll_adjustments_immutable BEFORE INSERT OR UPDATE OR DELETE ON payroll_adjustments
      FOR EACH ROW EXECUTE FUNCTION payroll_adjustments_guard();
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
    DROP TABLE IF EXISTS payroll_adjustments, payroll_items, payroll_runs, pay_policies,
      salary_structure_lines, salary_structures, salary_components, payroll_settings CASCADE;
    DROP FUNCTION IF EXISTS payroll_runs_guard();
    DROP FUNCTION IF EXISTS payroll_items_guard();
    DROP FUNCTION IF EXISTS payroll_adjustments_guard();
  `);
}
