/**
 * Migration 15: Employee Financial Claims
 * Adds employee_claims table (insurance, salary advance, loan requests) with RLS.
 */
export async function up(knex) {
  await knex.schema.createTable('employee_claims', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('organization_id').notNullable().references('id').inTable('organizations');
    t.uuid('employee_id').notNullable().references('id').inTable('employees');

    t.enu('claim_type', ['insurance', 'salary_advance', 'loan', 'other']).notNullable();
    t.string('claim_type_label', 100).nullable(); // for 'other'

    // Amount in paise (BigInt stored as numeric)
    t.specificType('requested_amount', 'numeric(15,0)').nullable();
    t.text('purpose').notNullable();
    t.date('requested_date').notNullable();

    // Loan / advance specific
    t.integer('duration_months').nullable(); // requested repayment period
    t.text('repayment_notes').nullable();

    t.text('supporting_document_url').nullable(); // future: file storage
    t.text('additional_comments').nullable();

    // Idempotency
    t.string('idempotency_key', 100).nullable();

    // Approval
    t.enu('status', ['pending', 'approved', 'rejected']).notNullable().defaultTo('pending');
    t.uuid('decided_by_user_id').nullable().references('id').inTable('users');
    t.timestamp('decided_at', { useTz: true }).nullable();
    t.text('decision_comment').nullable();

    // Repayment tracking
    t.specificType('approved_amount', 'numeric(15,0)').nullable();
    t.specificType('repaid_amount', 'numeric(15,0)').notNullable().defaultTo(0);
    t.boolean('repayment_complete').notNullable().defaultTo(false);

    t.timestamps(true, true);
  });

  await knex.raw(`ALTER TABLE employee_claims ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE employee_claims FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON employee_claims
      USING (
        current_setting('app.rls_bypass', true) = 'on'
        OR organization_id = current_setting('app.current_organization_id', true)::uuid
      )
  `);

  // Unique idempotency key per org
  await knex.schema.table('employee_claims', (t) => {
    t.unique(['organization_id', 'idempotency_key']);
    t.index(['organization_id', 'employee_id', 'status']);
    t.index(['organization_id', 'claim_type', 'status']);
    t.index(['organization_id', 'decided_by_user_id']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('employee_claims');
}
