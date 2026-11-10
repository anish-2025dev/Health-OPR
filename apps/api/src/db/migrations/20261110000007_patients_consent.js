/**
 * Phases 3 + 4: patient registration, contacts, family links, duplicate review, consent and privacy.
 *
 * Product rules (spec):
 * - A phone number identifies a contact channel, not a patient. One verified contact can be linked to
 *   several patient profiles through explicit relationship + authorization records.
 * - OTP possession is not proof of authority over a family member: links created through the public
 *   portal for anyone other than "self" stay pending until staff authorize them.
 * - Duplicates are flagged for staff review; records are never merged automatically.
 * - Consent is recorded separately per purpose (privacy notice, WhatsApp, SMS, marketing) with the
 *   notice version, channel, actor and timestamps; marketing is optional.
 */

const CURRENT_ORG = "nullif(current_setting('app.current_organization_id', true), '')::uuid";
const BYPASS = "coalesce(current_setting('app.rls_bypass', true), '') = 'on'";
const NEW_TABLES = [
  'patient_settings',
  'privacy_notice_versions',
  'contacts',
  'patients',
  'contact_patient_links',
  'consents',
  'patient_duplicate_flags',
  'data_principal_requests',
];

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE organizations
      ADD COLUMN next_patient_seq integer NOT NULL DEFAULT 1 CHECK (next_patient_seq > 0);

    CREATE TABLE patient_settings (
      organization_id            uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      name_similarity_threshold  numeric(3, 2) NOT NULL DEFAULT 0.85 CHECK (name_similarity_threshold BETWEEN 0.5 AND 1),
      match_requires_dob         boolean NOT NULL DEFAULT true,
      updated_at                 timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE privacy_notice_versions (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      version           text NOT NULL CHECK (length(version) BETWEEN 1 AND 30),
      language          text NOT NULL DEFAULT 'en' CHECK (language ~ '^[a-z]{2}$'),
      title             text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
      content           text NOT NULL CHECK (length(content) BETWEEN 20 AND 50000),
      status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
      published_at      timestamptz,
      created_by_user_id uuid,
      created_at        timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, version, language)
    );
    CREATE UNIQUE INDEX privacy_notice_one_published
      ON privacy_notice_versions (organization_id, language) WHERE status = 'published';

    CREATE TABLE contacts (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      phone_e164        text NOT NULL CHECK (phone_e164 ~ '^\\+[1-9][0-9]{7,14}$'),
      phone_verified_at timestamptz,
      created_at        timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, phone_e164)
    );

    CREATE TABLE patients (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      patient_number        text NOT NULL CHECK (patient_number ~ '^[A-Z0-9-]{1,20}$'),
      full_name             text NOT NULL CHECK (length(full_name) BETWEEN 2 AND 200),
      date_of_birth         date,
      gender                text CHECK (gender IS NULL OR gender IN ('female', 'male', 'other', 'undisclosed')),
      email                 text CHECK (email IS NULL OR position('@' IN email) > 1),
      address               text CHECK (address IS NULL OR length(address) <= 500),
      registered_branch_id  uuid,
      registration_source   text NOT NULL CHECK (registration_source IN ('reception', 'portal', 'kiosk')),
      status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'merged')),
      merged_into_patient_id uuid,
      created_by_user_id    uuid,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, patient_number),
      FOREIGN KEY (organization_id, registered_branch_id) REFERENCES branches (organization_id, id),
      FOREIGN KEY (organization_id, merged_into_patient_id) REFERENCES patients (organization_id, id),
      CHECK (status <> 'merged' OR merged_into_patient_id IS NOT NULL)
    );
    CREATE INDEX patients_org_name_idx ON patients (organization_id, lower(full_name));
    CREATE INDEX patients_org_dob_idx ON patients (organization_id, date_of_birth);

    CREATE TABLE contact_patient_links (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id        uuid NOT NULL,
      contact_id             uuid NOT NULL,
      patient_id             uuid NOT NULL,
      relationship           text NOT NULL CHECK (relationship IN (
                               'self', 'parent', 'child', 'spouse', 'sibling', 'guardian', 'caregiver', 'other')),
      authorization_status   text NOT NULL CHECK (authorization_status IN ('pending', 'authorized', 'revoked')),
      authorized_by_user_id  uuid,
      authorized_at          timestamptz,
      revoked_reason         text,
      created_via            text NOT NULL CHECK (created_via IN ('reception', 'portal', 'kiosk')),
      created_at             timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      UNIQUE (contact_id, patient_id),
      FOREIGN KEY (organization_id, contact_id) REFERENCES contacts (organization_id, id),
      FOREIGN KEY (organization_id, patient_id) REFERENCES patients (organization_id, id)
    );
    CREATE INDEX cpl_pending_idx ON contact_patient_links (organization_id, authorization_status);

    CREATE TABLE consents (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id       uuid NOT NULL,
      patient_id            uuid NOT NULL,
      acting_contact_id     uuid,
      acting_relationship   text,
      purpose               text NOT NULL CHECK (purpose IN ('privacy_notice', 'whatsapp_service', 'sms_service', 'marketing')),
      channel               text NOT NULL CHECK (channel IN ('reception', 'portal', 'kiosk', 'whatsapp')),
      notice_version_id     uuid,
      status                text NOT NULL CHECK (status IN ('granted', 'withdrawn')),
      captured_at           timestamptz NOT NULL DEFAULT now(),
      withdrawn_at          timestamptz,
      capture_source        text NOT NULL,
      captured_by_user_id   uuid,
      FOREIGN KEY (organization_id, patient_id) REFERENCES patients (organization_id, id),
      FOREIGN KEY (organization_id, acting_contact_id) REFERENCES contacts (organization_id, id),
      FOREIGN KEY (organization_id, notice_version_id) REFERENCES privacy_notice_versions (organization_id, id),
      CHECK (status <> 'withdrawn' OR withdrawn_at IS NOT NULL)
    );
    CREATE INDEX consents_patient_idx ON consents (organization_id, patient_id, purpose, captured_at DESC);

    CREATE TABLE patient_duplicate_flags (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id       uuid NOT NULL,
      patient_id            uuid NOT NULL,
      candidate_patient_id  uuid NOT NULL,
      score                 numeric(4, 3) NOT NULL,
      reasons               jsonb NOT NULL DEFAULT '[]'::jsonb,
      status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'not_duplicate', 'duplicate')),
      decided_by_user_id    uuid,
      decided_at            timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, patient_id) REFERENCES patients (organization_id, id),
      FOREIGN KEY (organization_id, candidate_patient_id) REFERENCES patients (organization_id, id),
      UNIQUE (patient_id, candidate_patient_id)
    );

    CREATE TABLE data_principal_requests (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id       uuid NOT NULL,
      patient_id            uuid NOT NULL,
      request_type          text NOT NULL CHECK (request_type IN ('access', 'correction', 'erasure', 'grievance', 'nomination')),
      details               text NOT NULL CHECK (length(details) BETWEEN 3 AND 2000),
      channel               text NOT NULL CHECK (channel IN ('reception', 'portal')),
      status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'rejected')),
      resolution            text,
      created_by_user_id    uuid,
      resolved_by_user_id   uuid,
      resolved_at           timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, patient_id) REFERENCES patients (organization_id, id),
      CHECK (status NOT IN ('completed', 'rejected') OR resolution IS NOT NULL)
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
    DROP TABLE IF EXISTS data_principal_requests, patient_duplicate_flags, consents,
      contact_patient_links, patients, contacts, privacy_notice_versions, patient_settings CASCADE;
    ALTER TABLE organizations DROP COLUMN IF EXISTS next_patient_seq;
  `);
}
