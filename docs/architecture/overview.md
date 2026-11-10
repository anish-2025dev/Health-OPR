# Architecture overview

## Shape

HealthOS is a **modular monolith** in a **monorepo**. There is one deployable API and one web app, and the
API is split into business modules with explicit boundaries.

```
          Browser (React SPA)          WhatsApp / SMS providers
                 │  HTTPS JSON              │  signed webhooks
                 ▼                          ▼
        ┌──────────────────────────────────────────────┐
        │  Express API  /api/v1                        │
        │  middleware: request id → logging → helmet → │
        │  CORS → JSON → auth (P2) → tenant ctx (P2)   │
        │  ┌─────────┬─────────┬─────────┬──────────┐  │
        │  │ patients│ queue   │ hr-*    │ audit …  │  │  modules: routes → service → repository
        │  └─────────┴─────────┴─────────┴──────────┘  │
        └───────────┬──────────────────────┬───────────┘
                    │                      │
              PostgreSQL 17           Redis 7
          (system of record, RLS)   (cache, rate limits, job queue,
                                     realtime pub/sub)
                                           │
                                     Worker process (BullMQ, later)
                                     notifications, webhooks, reports
```

## Request lifecycle (target state after Phase 2)

1. `requestId` assigns or accepts a safe `x-request-id`.
2. `pino-http` logs only the id, method, path and status (no headers, query or body).
3. `helmet` and CORS (restricted to `FRONTEND_URL`).
4. Authentication resolves the user from a short-lived access token. Refresh sessions rotate and can be revoked.
5. Tenant context: `organization_id` and permitted `branch_id`s come from the authenticated user, never
   from client input.
6. A route validates input with zod and checks permissions.
7. The service runs business rules and opens a transaction, which sets
   `app.current_organization_id` for RLS.
8. The repository runs queries that are always filtered by tenant.
9. Errors become the standard envelope `{ error: { code, message, requestId } }`.

## Module boundaries

See `apps/api/src/modules/README.md`. Modules communicate only through each other's `index.js`. Patient
administrative data, clinical data (later), and HR/payroll data are separate modules with separate
permissions. HR roles do not get patient access by default, and receptionists do not get payroll access
by default.

## Realtime

Live queue boards (Phase 5) use WebSockets from the API process, with Redis pub/sub fan-out so the API
can scale beyond one instance. Patient-facing wait times are always labelled approximate.

## Background work

Notifications, webhook processing, report generation and retries run in a separate worker process that
reads a Redis-backed queue (BullMQ). Webhooks are acknowledged quickly, deduplicated by provider event id,
then processed asynchronously.

## Integrations

Every external provider (WhatsApp Cloud API, MSG91/SMS, email, S3-compatible storage, payments) sits
behind an adapter interface in `apps/api/src/integrations/<kind>/`, so vendors can be swapped and tests
can use fakes.

## Deployment (initial)

Managed container hosting for `apps/api` (and a worker) plus a static host or CDN for `apps/web`, with
managed PostgreSQL and Redis in an Indian region. The final provider will be chosen after a cost and
compliance review. The future AWS path is ECS, RDS PostgreSQL, ElastiCache, S3, CloudFront and CloudWatch.
