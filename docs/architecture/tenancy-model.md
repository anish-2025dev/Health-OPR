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
2. **Database layer (defence in depth).** Tenant tables have PostgreSQL row-level security enabled, for
   example:

   ```sql
   ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
   ALTER TABLE patients FORCE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON patients
     USING (organization_id = current_setting('app.current_organization_id', true)::uuid)
     WITH CHECK (organization_id = current_setting('app.current_organization_id', true)::uuid);
   ```

   The API connects as a non-owner role, so RLS applies to it. Each tenant-scoped unit of work runs in a
   transaction that first executes `SELECT set_config('app.current_organization_id', $1, true)`. The
   setting is transaction-local, so it cannot leak through pooled connections.

3. **Tests.** Every module gets "tenant A cannot read or modify tenant B" tests, at both the API level
   and the raw RLS level.

## Constraints and indexes

- Tenant-scoped identifiers are unique per tenant, for example `UNIQUE (organization_id, patient_number)`.
- Composite indexes lead with `organization_id`, and with `branch_id` and a date where relevant.
- Foreign keys between tenant tables include `organization_id`, so a row cannot reference another
  tenant's row.

## Platform staff

`platform_support` access to tenant data is off by default. When granted, it is time-boxed, requires a
justification and is written to the audit log.
