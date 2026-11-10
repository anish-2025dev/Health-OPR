# 0004: Shared-schema multi-tenancy with RLS

**Status:** Accepted

## Context

There will be many small tenants (clinics) and some larger ones (hospital groups with branches). The
spec requires that patient or employee data is never exposed across tenants.

## Decision

All tenants share one database and one schema. Tenant isolation is enforced by:

1. Mandatory tenant context in every repository call, derived from the authenticated session.
2. PostgreSQL row-level security on every tenant table. The policy compares against
   `current_setting('app.current_organization_id')`, which is set transaction-locally.
3. The API connecting as a non-owner role, with `FORCE ROW LEVEL SECURITY` enabled.
4. Mandatory cross-tenant tests for every module.

Details are in `docs/architecture/tenancy-model.md`.

## Consequences

- Cheap to operate and simple to migrate (one schema).
- Every tenant-scoped query must run inside a transaction that sets the tenant. A helper (Phase 2) makes
  this the default path.
- Very large tenants could later move to a dedicated database without changing the code model.
