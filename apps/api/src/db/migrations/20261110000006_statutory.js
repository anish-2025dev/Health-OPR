/**
 * Phase 11: statutory payroll rules.
 *
 * No statutory rate, ceiling, slab or date is built into the software (AGENTS.md hard rule). Each
 * organization enters its rules with a source reference; a rule is used only after it is approved, and
 * only within its effective dates. Every payslip records the rule versions it used.
 *
 * - statutory_rules: epf, esi, professional_tax (per state), lwf (per state), gratuity (tracking).
 * - employee_statutory: which rules apply to each employee, their PT/LWF state, and the monthly TDS
 *   amount set by payroll (income-tax computation itself is outside the pilot).
 */

const CURRENT_ORG = "nullif(current_setting('app.current_organization_id', true), '')::uuid";
const BYPASS = "coalesce(current_setting('app.rls_bypass', true), '') = 'on'";
const NEW_TABLES = ['statutory_rules', 'employee_statutory'];

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE statutory_rules (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      rule_type            text NOT NULL CHECK (rule_type IN ('epf', 'esi', 'professional_tax', 'lwf', 'gratuity')),
      jurisdiction         text NOT NULL DEFAULT 'IN' CHECK (jurisdiction ~ '^[A-Z]{2}$'),
      effective_from       date NOT NULL,
      effective_to         date,
      configuration_json   jsonb NOT NULL,
      source_reference     text NOT NULL CHECK (length(source_reference) BETWEEN 3 AND 500),
      approval_status      text NOT NULL DEFAULT 'draft' CHECK (approval_status IN ('draft', 'approved', 'retired')),
      created_by_user_id   uuid,
      approved_by_user_id  uuid,
      approved_at          timestamptz,
      created_at           timestamptz NOT NULL DEFAULT now(),
      CHECK (effective_to IS NULL OR effective_to >= effective_from)
    );
    CREATE INDEX statutory_rules_lookup_idx
      ON statutory_rules (organization_id, rule_type, jurisdiction, effective_from);

    -- An approved rule's terms never change; to change them, retire it and approve a new version.
    CREATE FUNCTION statutory_rules_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' AND OLD.approval_status <> 'draft' THEN
        RAISE EXCEPTION 'approved statutory rules cannot be deleted';
      END IF;
      IF TG_OP = 'UPDATE' AND OLD.approval_status <> 'draft' AND (
        NEW.configuration_json IS DISTINCT FROM OLD.configuration_json
        OR NEW.rule_type IS DISTINCT FROM OLD.rule_type
        OR NEW.jurisdiction IS DISTINCT FROM OLD.jurisdiction
        OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
        OR NEW.source_reference IS DISTINCT FROM OLD.source_reference) THEN
        RAISE EXCEPTION 'approved statutory rules are immutable; create a new version';
      END IF;
      RETURN COALESCE(NEW, OLD);
    END
    $$;
    CREATE TRIGGER statutory_rules_immutable BEFORE UPDATE OR DELETE ON statutory_rules
      FOR EACH ROW EXECUTE FUNCTION statutory_rules_guard();

    CREATE TABLE employee_statutory (
      employee_id          uuid PRIMARY KEY,
      organization_id      uuid NOT NULL,
      pf_applicable        boolean NOT NULL DEFAULT false,
      esi_applicable       boolean NOT NULL DEFAULT false,
      lwf_applicable       boolean NOT NULL DEFAULT false,
      pt_state             text CHECK (pt_state IS NULL OR pt_state ~ '^[A-Z]{2}$'),
      tds_monthly_amount   numeric(12, 2) CHECK (tds_monthly_amount IS NULL OR tds_monthly_amount >= 0),
      updated_by_user_id   uuid,
      updated_at           timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, employee_id) REFERENCES employees (organization_id, id) ON DELETE CASCADE
    );
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
    DROP TABLE IF EXISTS employee_statutory, statutory_rules CASCADE;
    DROP FUNCTION IF EXISTS statutory_rules_guard();
  `);
}
