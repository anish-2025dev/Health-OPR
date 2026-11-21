/**
 * Migration 17: Decouple doctors table from departments table for independent Suntek-ops operation.
 *
 * Updates the composite foreign key constraint on doctors (organization_id, department_id)
 * to include ON DELETE SET NULL, ensuring that department lifecycle changes or de-linking in
 * Suntek-Mgt (HRMS) never blocks or breaks doctor records in Suntek-ops (Hospital Operations).
 */

export async function up(knex) {
  // Drop existing foreign key constraint on doctors.department_id
  await knex.raw(`
    DO $$
    DECLARE
        r RECORD;
    BEGIN
        FOR r IN (
            SELECT constraint_name
            FROM information_schema.table_constraints
            WHERE table_schema = current_schema()
              AND table_name = 'doctors'
              AND constraint_type = 'FOREIGN KEY'
              AND constraint_name LIKE '%department%'
        ) LOOP
            EXECUTE 'ALTER TABLE doctors DROP CONSTRAINT ' || quote_ident(r.constraint_name);
        END LOOP;
    END $$;
  `);

  // Re-add foreign key with ON DELETE SET NULL
  await knex.raw(`
    ALTER TABLE doctors
      ADD CONSTRAINT doctors_organization_id_department_id_fkey
      FOREIGN KEY (organization_id, department_id)
      REFERENCES departments (organization_id, id)
      ON DELETE SET NULL;
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE doctors DROP CONSTRAINT IF EXISTS doctors_organization_id_department_id_fkey;
  `);

  // Restore the original foreign key (standard RESTRICT)
  await knex.raw(`
    ALTER TABLE doctors
      ADD CONSTRAINT doctors_organization_id_department_id_fkey
      FOREIGN KEY (organization_id, department_id)
      REFERENCES departments (organization_id, id);
  `);
}
