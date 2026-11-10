# Tenancy model

## Hierarchy

```
organization (tenant: hospital group / clinic business)
  └── branch (physical clinic/hospital location, own timezone, hours, QR codes)
        └── departments, doctors, queues, employees …
```

## Storage strategy

All tenants share one database and one schema, and every tenant-owned row carries `organization_id`.
Branch-level data also carries `branch_id`.

Isolation is enforced in three layers:

1. **Application layer.** The tenant context comes from the authenticated session, never from request
   bodies or query parameters. Every repository function requires it and filters on it.
2. **Database layer (defence in depth).** Every tenant table has PostgreSQL row-level security
   **enabled and forced**, so it also applies to the table owner the API connects as:

   ```sql
   ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
   ALTER TABLE branches FORCE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON branches
     USING      (app.rls_bypass = 'on' OR organization_id = app.current_organization_id)
     WITH CHECK (app.rls_bypass = 'on' OR organization_id = app.current_organization_id);
   ```

   (simplified; the real policies read these settings with `current_setting(..., true)`.)

   The code reaches the database through two helpers in `apps/api/src/core/db.js`:

   | Helper                      | Sets (transaction-local)              | Use for                                                                                                        |
   | --------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
   | `withTenant(db, orgId, fn)` | `app.current_organization_id = orgId` | **All** request handling for tenant data                                                                       |
   | `withSystem(db, fn)`        | `app.rls_bypass = on`                 | Only before a tenant is known: login lookup by email, refresh-token lookup, organization bootstrap, test setup |

   A query made outside both helpers sees **no tenant rows** and cannot insert any (fail closed).
   The settings are transaction-local (`set_config(..., true)`), so they never leak to another request
   through pooled connections, including Neon's PgBouncer transaction pooling.

   **The API's database role must not be a superuser or have `BYPASSRLS`**, because PostgreSQL skips RLS
   for those. The API checks this at startup and refuses to start in staging/production. Local compose
   creates a normal `healthos_app` role for the API; the `healthos_admin` superuser is for administration only.

3. **Tests.** Every module gets "tenant A cannot read or modify tenant B" tests, at both the API level
   and the raw RLS level (`apps/api/tests/integration/tenant-isolation.test.js`).

## Roles and permissions

- System roles (`organization_owner`, `organization_admin`, `clinic_manager`, `receptionist`, `doctor`,
  `nurse`, `hr_manager`, `payroll_manager`, `department_manager`, `employee`) and their permissions are
  defined in code (`apps/api/src/modules/staff-access/permissions.js`). Assignments are stored per user in
  `user_role_assignments`, optionally limited to one branch (`branch_id`; `NULL` = all branches).
- Custom, organization-defined roles can be added later with a `roles` table, without changing how
  permissions are checked.
- Only an organization owner can grant or remove the owner role. Nobody can change their own roles.
- Staff email addresses are globally unique, so sign-in doesn't need an organization picker (pilot
  decision). A person who works for two organizations needs two emails for now.

## Constraints and indexes

- Tenant-scoped identifiers are unique per tenant, for example `UNIQUE (organization_id, patient_number)`.
- Composite indexes lead with `organization_id`, and with `branch_id` and a date where relevant.
- Foreign keys between tenant tables include `organization_id`, so a row cannot reference another
  tenant's row.

## Platform staff

`platform_support` access to tenant data is off by default. When granted, it is time-boxed, requires a
justification and is written to the audit log.
