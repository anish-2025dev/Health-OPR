/**
 * Phases 5 + 7: doctors, weekly schedules, time off, appointments, queue entries and tokens.
 *
 * - Workflows are distinct (spec): appointment booking, walk-in registration, arrival check-in and
 *   queue management.
 * - A token is issued transactionally per doctor and service date (the queue scope) from
 *   queue_counters, so concurrent bookings can't receive the same number. The token number lives on
 *   the queue entry (token_number, token_issued_at) instead of a separate tokens table.
 * - Appointments get their token at booking time, so patients can follow the queue from home.
 *   Walk-ins get the next token when they are registered at the desk.
 * - Idempotency keys stop retried requests (and repeated webhooks) from booking twice.
 * - tracking_code is a random, unguessable value for the patient's live status link. The status page
 *   shows token numbers and estimates only: no names or medical details.
 */

const CURRENT_ORG = "nullif(current_setting('app.current_organization_id', true), '')::uuid";
const BYPASS = "coalesce(current_setting('app.rls_bypass', true), '') = 'on'";
const NEW_TABLES = [
  'doctors',
  'doctor_schedules',
  'doctor_time_off',
  'appointments',
  'queue_counters',
  'queue_entries',
];

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE doctors (
      id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      branch_id               uuid NOT NULL,
      user_id                 uuid,
      department_id           uuid,
      display_name            text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 200),
      specialization          text CHECK (specialization IS NULL OR length(specialization) <= 200),
      consultation_minutes    integer NOT NULL DEFAULT 10 CHECK (consultation_minutes BETWEEN 2 AND 240),
      booking_window_days     integer NOT NULL DEFAULT 14 CHECK (booking_window_days BETWEEN 0 AND 180),
      online_booking_enabled  boolean NOT NULL DEFAULT true,
      status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      created_at              timestamptz NOT NULL DEFAULT now(),
      updated_at              timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, user_id),
      FOREIGN KEY (organization_id, branch_id) REFERENCES branches (organization_id, id),
      FOREIGN KEY (organization_id, department_id) REFERENCES departments (organization_id, id)
    );

    -- Weekly consultation sessions in local wall-clock time of the doctor's branch.
    CREATE TABLE doctor_schedules (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL,
      doctor_id         uuid NOT NULL,
      day_of_week       smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      start_time        time NOT NULL,
      end_time          time NOT NULL,
      slot_minutes      integer NOT NULL CHECK (slot_minutes BETWEEN 5 AND 240),
      patients_per_slot integer NOT NULL DEFAULT 1 CHECK (patients_per_slot BETWEEN 1 AND 50),
      FOREIGN KEY (organization_id, doctor_id) REFERENCES doctors (organization_id, id) ON DELETE CASCADE,
      CHECK (end_time > start_time)
    );
    CREATE INDEX doctor_schedules_idx ON doctor_schedules (organization_id, doctor_id, day_of_week);

    CREATE TABLE doctor_time_off (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL,
      doctor_id         uuid NOT NULL,
      date              date NOT NULL,
      reason            text CHECK (reason IS NULL OR length(reason) <= 200),
      created_at        timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (organization_id, doctor_id) REFERENCES doctors (organization_id, id) ON DELETE CASCADE,
      UNIQUE (doctor_id, date)
    );

    CREATE TABLE appointments (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id       uuid NOT NULL,
      branch_id             uuid NOT NULL,
      patient_id            uuid NOT NULL,
      doctor_id             uuid NOT NULL,
      appointment_date      date NOT NULL,
      slot_start            timestamptz NOT NULL,
      slot_end              timestamptz NOT NULL,
      status                text NOT NULL DEFAULT 'booked'
                              CHECK (status IN ('booked', 'checked_in', 'completed', 'cancelled', 'no_show')),
      source                text NOT NULL CHECK (source IN ('reception', 'portal', 'whatsapp')),
      idempotency_key       text,
      booked_by_user_id     uuid,
      booked_by_contact_id  uuid,
      cancel_reason         text,
      cancelled_at          timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, idempotency_key),
      FOREIGN KEY (organization_id, branch_id) REFERENCES branches (organization_id, id),
      FOREIGN KEY (organization_id, patient_id) REFERENCES patients (organization_id, id),
      FOREIGN KEY (organization_id, doctor_id) REFERENCES doctors (organization_id, id),
      CHECK (slot_end > slot_start)
    );
    CREATE INDEX appointments_doctor_day_idx ON appointments (organization_id, doctor_id, appointment_date);
    CREATE INDEX appointments_patient_idx ON appointments (organization_id, patient_id, appointment_date DESC);
    -- A patient can hold only one active appointment per doctor per day.
    CREATE UNIQUE INDEX appointments_one_per_day
      ON appointments (organization_id, patient_id, doctor_id, appointment_date)
      WHERE status IN ('booked', 'checked_in');

    CREATE TABLE queue_counters (
      organization_id   uuid NOT NULL,
      doctor_id         uuid NOT NULL,
      queue_date        date NOT NULL,
      last_token        integer NOT NULL DEFAULT 0,
      PRIMARY KEY (organization_id, doctor_id, queue_date),
      FOREIGN KEY (organization_id, doctor_id) REFERENCES doctors (organization_id, id)
    );

    CREATE TABLE queue_entries (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   uuid NOT NULL,
      branch_id         uuid NOT NULL,
      doctor_id         uuid NOT NULL,
      queue_date        date NOT NULL,
      patient_id        uuid NOT NULL,
      appointment_id    uuid,
      token_number      integer NOT NULL CHECK (token_number > 0),
      token_issued_at   timestamptz NOT NULL DEFAULT now(),
      kind              text NOT NULL CHECK (kind IN ('appointment', 'walk_in')),
      status            text NOT NULL CHECK (status IN (
                          'booked', 'waiting', 'called', 'in_consultation', 'completed',
                          'no_show', 'cancelled')),
      priority          smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 2),
      priority_reason   text,
      tracking_code     text NOT NULL UNIQUE,
      idempotency_key   text,
      checked_in_at     timestamptz,
      called_at         timestamptz,
      started_at        timestamptz,
      completed_at      timestamptz,
      created_by_user_id uuid,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, id),
      UNIQUE (organization_id, idempotency_key),
      UNIQUE (organization_id, doctor_id, queue_date, token_number),
      UNIQUE (appointment_id),
      FOREIGN KEY (organization_id, branch_id) REFERENCES branches (organization_id, id),
      FOREIGN KEY (organization_id, doctor_id) REFERENCES doctors (organization_id, id),
      FOREIGN KEY (organization_id, patient_id) REFERENCES patients (organization_id, id),
      FOREIGN KEY (organization_id, appointment_id) REFERENCES appointments (organization_id, id)
    );
    CREATE INDEX queue_entries_board_idx ON queue_entries (organization_id, doctor_id, queue_date, status);
    CREATE INDEX queue_entries_patient_idx ON queue_entries (organization_id, patient_id, queue_date DESC);
    -- Walk-ins: one active queue entry per patient per doctor per day.
    CREATE UNIQUE INDEX queue_one_active_per_day
      ON queue_entries (organization_id, patient_id, doctor_id, queue_date)
      WHERE status IN ('booked', 'waiting', 'called', 'in_consultation');
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
    DROP TABLE IF EXISTS queue_entries, queue_counters, appointments, doctor_time_off,
      doctor_schedules, doctors CASCADE;
  `);
}
