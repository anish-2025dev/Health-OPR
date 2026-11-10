# 0004: Shared-schema multi-tenancy with RLS

**Status:** Accepted

## Context

There will be many small tenants (clinics) and some larger ones (hospital groups with branches). The
spec requires that patient or employee data is never exposed across tenants.

## Decision

All tenants share one database and one schema. Tenant isolation is enforced by:

1. Mandatory tenant context in every repository call, derived from the authenticated session.
2. PostgreSQL row-level security, **enabled and forced** on every tenant table, so it also applies to the
   table owner. The policy compares against `app.current_organization_id`, set transaction-locally by
   `withTenant()`.
3. A small number of pre-tenant code paths (login lookup, refresh-token lookup, organization bootstrap)
   use `withSystem()`, which sets a transaction-local `app.rls_bypass` flag. Everything else fails closed:
   with no context set, no tenant rows are visible.
4. The API's database role must not be a superuser or have `BYPASSRLS` (checked at startup).
5. Mandatory cross-tenant tests for every module.

_Implementation note (Phase 2):_ an earlier draft switched to a separate NOLOGIN role with `SET LOCAL ROLE`.
That needs role-membership privileges that a Neon-style non-superuser owner may not have when the role
already exists, so we chose forced RLS with an explicit system flag. It works with any ordinary owner role
and fails closed.

Details are in `docs/architecture/tenancy-model.md`.

## Consequences

- Cheap to operate and simple to migrate (one schema).
- Every tenant-scoped query must run inside a transaction that sets the tenant. A helper (Phase 2) makes
  this the default path.
- Very large tenants could later move to a dedicated database without changing the code model.
