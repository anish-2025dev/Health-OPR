/**
 * Phase 8: organization structure and employees.
 *
 * Tables: departments, designations, shifts, holidays, employees.
 * Branches gain a geofence (latitude, longitude, radius) used by attendance in Phase 9a.
 * Organizations gain a counter for auto-generated employee numbers.
 *
 * Every new table has RLS enabled and FORCED, with the same policy as the Phase 2 tables.
 */

const CURRENT_ORG = "nullif(current_setting('app.current_organization_id', true), '')::uuid";
const BYPASS = "coalesce(current_setting('app.rls_bypass', true), '') = 'on'";
const NEW_TABLES = ['departments', 'designations', 'shifts', 'holidays', 'employees'];

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE organizations
      ADD COLUMN next_employee_seq integer NOT NULL DEFAULT 1 CHECK (next_employee_seq > 0);

    ALTER TABLE branches
      ADD COLUMN latitude numeric(9, 6) CHECK (latitude BETWEEN -90 AND 90),
      ADD COLUMN longitude numeric(9, 6) CHECK (longitude BETWEEN -180 AND 180),
      ADD COLUMN geofence_radius_m integer NOT NULL DEFAULT 10
        CHECK (geofence_radius_m BETWEEN 5 AND 1000),
      ADD CONSTRAINT branches_location_pair CHECK ((latitude IS NULL) = (longitude IS NULL));

    CREATE TABLE departments (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
      status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id)
    );
    CREATE UNIQUE INDEX departments_org_name_unique ON departments (organization_id, lower(name));

    CREATE TABLE designations (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
      status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id)
    );
    CREATE UNIQUE INDEX designations_org_name_unique ON designations (organization_id, lower(name));

    -- Shift templates. Times are local wall-clock times in the branch timezone.
    CREATE TABLE shifts (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
      start_time       time NOT NULL,
      end_time         time NOT NULL,
      break_minutes    integer NOT NULL DEFAULT 0 CHECK (break_minutes BETWEEN 0 AND 240),
      status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      CHECK (start_time <> end_time),
      UNIQUE (organization_id, id)
    );
    CREATE UNIQUE INDEX shifts_org_name_unique ON shifts (organization_id, lower(name));

    -- Company holidays. branch_id NULL = applies to every branch.
    CREATE TABLE holidays (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      branch_id        uuid,
      holiday_date     date NOT NULL,
      name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
      is_optional      boolean NOT NULL DEFAULT false,
      created_at       timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, branch_id) REFERENCES branches (organization_id, id) ON DELETE CASCADE,
      UNIQUE NULLS NOT DISTINCT (organization_id, branch_id, holiday_date)
    );
    CREATE INDEX holidays_org_date_idx ON holidays (organization_id, holiday_date);

    CREATE TABLE employees (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      branch_id            uuid NOT NULL,
      employee_number      text NOT NULL CHECK (employee_number ~ '^[A-Za-z0-9-]{1,20}$'),
      full_name            text NOT NULL CHECK (length(full_name) BETWEEN 2 AND 200),
      -- Mobile used for OTP sign-in and attendance OTPs. One employee per number per organization.
      mobile_e164          text NOT NULL CHECK (mobile_e164 ~ '^\\+[1-9][0-9]{7,14}$'),
      email                text CHECK (email IS NULL OR position('@' IN email) > 1),
      user_id              uuid,
      department_id        uuid,
      designation_id       uuid,
      reporting_manager_id uuid,
      shift_id             uuid,
      -- Weekly off days, 0 = Sunday … 6 = Saturday.
      weekly_off_days      smallint[] NOT NULL DEFAULT '{0}'
        CHECK (weekly_off_days <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
      employment_type      text NOT NULL DEFAULT 'full_time'
        CHECK (employment_type IN ('full_time', 'part_time', 'contract', 'intern', 'consultant')),
      joining_date         date NOT NULL,
      exit_date            date,
      employment_status    text NOT NULL DEFAULT 'active'
        CHECK (employment_status IN ('active', 'on_notice', 'suspended', 'exited')),
      emergency_contact_name  text CHECK (emergency_contact_name IS NULL OR length(emergency_contact_name) <= 200),
      emergency_contact_phone text CHECK (emergency_contact_phone IS NULL OR emergency_contact_phone ~ '^\\+[1-9][0-9]{7,14}$'),
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, employee_number),
      UNIQUE (organization_id, mobile_e164),
      UNIQUE (organization_id, user_id),
      CHECK (exit_date IS NULL OR exit_date >= joining_date),
      CHECK (employment_status <> 'exited' OR exit_date IS NOT NULL),
      CHECK (reporting_manager_id IS NULL OR reporting_manager_id <> id),
      FOREIGN KEY (organization_id, branch_id) REFERENCES branches (organization_id, id),
      FOREIGN KEY (organization_id, user_id) REFERENCES users (organization_id, id) ON DELETE SET NULL (user_id),
      FOREIGN KEY (organization_id, department_id) REFERENCES departments (organization_id, id) ON DELETE SET NULL (department_id),
      FOREIGN KEY (organization_id, designation_id) REFERENCES designations (organization_id, id) ON DELETE SET NULL (designation_id),
      FOREIGN KEY (organization_id, reporting_manager_id) REFERENCES employees (organization_id, id) ON DELETE SET NULL (reporting_manager_id),
      FOREIGN KEY (organization_id, shift_id) REFERENCES shifts (organization_id, id) ON DELETE SET NULL (shift_id)
    );
    CREATE INDEX employees_org_branch_idx ON employees (organization_id, branch_id, employment_status);
    CREATE INDEX employees_org_dept_idx ON employees (organization_id, department_id);
    CREATE INDEX employees_org_manager_idx ON employees (organization_id, reporting_manager_id);
    CREATE INDEX employees_org_name_idx ON employees (organization_id, lower(full_name));
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
    DROP TABLE IF EXISTS employees, holidays, shifts, designations, departments CASCADE;
    ALTER TABLE branches
      DROP CONSTRAINT IF EXISTS branches_location_pair,
      DROP COLUMN IF EXISTS geofence_radius_m,
      DROP COLUMN IF EXISTS longitude,
      DROP COLUMN IF EXISTS latitude;
    ALTER TABLE organizations DROP COLUMN IF EXISTS next_employee_seq;
  `);
}
