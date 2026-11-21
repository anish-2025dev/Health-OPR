/**
 * Migration 14: Task Management System
 * Adds tasks and task_comments tables with RLS.
 */
export async function up(knex) {
  await knex.schema.createTable('tasks', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('organization_id').notNullable().references('id').inTable('organizations');
    t.uuid('branch_id').nullable().references('id').inTable('branches');
    t.uuid('department_id').nullable().references('id').inTable('departments');

    t.string('title', 200).notNullable();
    t.text('description').nullable();

    // Who created and who is assigned
    t.uuid('created_by_user_id').nullable().references('id').inTable('users');
    t.uuid('assigned_to_employee_id').nullable().references('id').inTable('employees');
    t.uuid('assigned_by_user_id').nullable().references('id').inTable('users');

    t.enu('priority', ['low', 'medium', 'high', 'critical']).notNullable().defaultTo('medium');
    t.enu('status', ['pending', 'in_progress', 'on_hold', 'completed', 'cancelled'])
      .notNullable()
      .defaultTo('pending');

    t.date('start_date').nullable();
    t.date('deadline').nullable();
    t.timestamp('completed_at', { useTz: true }).nullable();
    t.text('completion_notes').nullable();

    // Soft-delete / archive
    t.boolean('is_archived').notNullable().defaultTo(false);

    t.timestamps(true, true);
  });

  await knex.schema.createTable('task_comments', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('organization_id').notNullable().references('id').inTable('organizations');
    t.uuid('task_id').notNullable().references('id').inTable('tasks').onDelete('CASCADE');
    t.uuid('author_user_id').nullable().references('id').inTable('users');
    t.uuid('author_employee_id').nullable().references('id').inTable('employees');
    t.text('body').notNullable();
    t.timestamps(true, true);
  });

  // RLS: enabled and forced on both tables
  for (const table of ['tasks', 'task_comments']) {
    await knex.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON ${table}
        USING (
          current_setting('app.rls_bypass', true) = 'on'
          OR organization_id = current_setting('app.current_organization_id', true)::uuid
        )
    `);
  }

  // Indexes
  await knex.schema.table('tasks', (t) => {
    t.index(['organization_id', 'assigned_to_employee_id', 'status']);
    t.index(['organization_id', 'deadline']);
    t.index(['organization_id', 'created_at']);
  });
  await knex.schema.table('task_comments', (t) => {
    t.index(['task_id', 'created_at']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('task_comments');
  await knex.schema.dropTableIfExists('tasks');
}
