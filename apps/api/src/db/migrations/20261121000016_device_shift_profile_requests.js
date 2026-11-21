/**
 * Migration 16: Device registrations, shift-change requests, and profile-update requests.
 */
export async function up(knex) {
  // ── Device registrations ────────────────────────────────────────────────
  await knex.schema.createTable('employee_device_registrations', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('organization_id').notNullable().references('id').inTable('organizations');
    t.uuid('employee_id').notNullable().references('id').inTable('employees');
    // A fingerprint generated client-side (platform, browser, screen, etc.)
    t.string('device_fingerprint', 500).notNullable();
    t.string('device_label', 200).nullable(); // "iPhone 14 / Safari 17"
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamp('registered_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen_at', { useTz: true }).nullable();
    t.timestamps(true, true);
  });

  await knex.raw(`ALTER TABLE employee_device_registrations ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE employee_device_registrations FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON employee_device_registrations
      USING (
        current_setting('app.rls_bypass', true) = 'on'
        OR organization_id = current_setting('app.current_organization_id', true)::uuid
      )
  `);

  await knex.schema.table('employee_device_registrations', (t) => {
    t.index(['organization_id', 'employee_id', 'is_active']);
  });

  // ── Shift-change requests ───────────────────────────────────────────────
  await knex.schema.createTable('shift_change_requests', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('organization_id').notNullable().references('id').inTable('organizations');
    t.uuid('employee_id').notNullable().references('id').inTable('employees');

    t.enu('request_type', ['temporary', 'permanent', 'swap']).notNullable();

    // Requested shift
    t.uuid('current_shift_id').nullable().references('id').inTable('shifts');
    t.uuid('requested_shift_id').nullable().references('id').inTable('shifts');

    // For swaps: the other employee
    t.uuid('swap_with_employee_id').nullable().references('id').inTable('employees');

    // For temporary changes
    t.date('effective_from').nullable();
    t.date('effective_to').nullable();

    t.text('reason').notNullable();

    t.enu('status', ['pending', 'approved', 'rejected']).notNullable().defaultTo('pending');
    t.uuid('decided_by_user_id').nullable().references('id').inTable('users');
    t.timestamp('decided_at', { useTz: true }).nullable();
    t.text('decision_comment').nullable();

    t.timestamps(true, true);
  });

  await knex.raw(`ALTER TABLE shift_change_requests ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE shift_change_requests FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON shift_change_requests
      USING (
        current_setting('app.rls_bypass', true) = 'on'
        OR organization_id = current_setting('app.current_organization_id', true)::uuid
      )
  `);

  await knex.schema.table('shift_change_requests', (t) => {
    t.index(['organization_id', 'employee_id', 'status']);
    t.index(['organization_id', 'status', 'created_at']);
  });

  // ── Profile-update requests ─────────────────────────────────────────────
  await knex.schema.createTable('profile_update_requests', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('organization_id').notNullable().references('id').inTable('organizations');
    t.uuid('employee_id').notNullable().references('id').inTable('employees');

    // JSON: { field: 'mobile_number', current_value: '...', requested_value: '...' }
    t.jsonb('changes').notNullable();
    t.text('reason').notNullable();

    t.enu('status', ['pending', 'approved', 'rejected']).notNullable().defaultTo('pending');
    t.uuid('decided_by_user_id').nullable().references('id').inTable('users');
    t.timestamp('decided_at', { useTz: true }).nullable();
    t.text('decision_comment').nullable();

    // Audit: what was actually applied
    t.jsonb('applied_changes').nullable();

    t.timestamps(true, true);
  });

  await knex.raw(`ALTER TABLE profile_update_requests ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE profile_update_requests FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON profile_update_requests
      USING (
        current_setting('app.rls_bypass', true) = 'on'
        OR organization_id = current_setting('app.current_organization_id', true)::uuid
      )
  `);

  await knex.schema.table('profile_update_requests', (t) => {
    t.index(['organization_id', 'employee_id', 'status']);
    t.index(['organization_id', 'status', 'created_at']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('profile_update_requests');
  await knex.schema.dropTableIfExists('shift_change_requests');
  await knex.schema.dropTableIfExists('employee_device_registrations');
}
