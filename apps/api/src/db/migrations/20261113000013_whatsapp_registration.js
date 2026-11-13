/**
 * WhatsApp self-registration (ADR 0010): allow "whatsapp" as the channel a patient record and its
 * contact link were created through.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE patients DROP CONSTRAINT patients_registration_source_check;
    ALTER TABLE patients ADD CONSTRAINT patients_registration_source_check
      CHECK (registration_source IN ('reception', 'portal', 'kiosk', 'whatsapp'));
    ALTER TABLE contact_patient_links DROP CONSTRAINT contact_patient_links_created_via_check;
    ALTER TABLE contact_patient_links ADD CONSTRAINT contact_patient_links_created_via_check
      CHECK (created_via IN ('reception', 'portal', 'kiosk', 'whatsapp'));
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE patients DROP CONSTRAINT patients_registration_source_check;
    ALTER TABLE patients ADD CONSTRAINT patients_registration_source_check
      CHECK (registration_source IN ('reception', 'portal', 'kiosk'));
    ALTER TABLE contact_patient_links DROP CONSTRAINT contact_patient_links_created_via_check;
    ALTER TABLE contact_patient_links ADD CONSTRAINT contact_patient_links_created_via_check
      CHECK (created_via IN ('reception', 'portal', 'kiosk'));
  `);
}
