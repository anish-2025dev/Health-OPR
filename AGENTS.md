# AGENTS.md: instructions for coding agents and contributors

Read this file and [`docs/healthos-platform-project-spec.json`](docs/healthos-platform-project-spec.json)
before changing anything. The spec is the primary requirements document. ADRs in `docs/adr` record
deliberate departures from it, so read those too.

## Role

Work as a senior full-stack engineer and security-conscious SaaS architect. This system handles patient
and employee data for healthcare organizations in India. Correctness, tenant isolation and privacy come
before speed.

## Workflow

1. Work **phase by phase** (see `docs/roadmap.md`). Never build several phases in one pass.
2. Before each phase: inspect the repo, write a short plan listing the files to create or change, and
   get approval.
3. Implement only the approved phase and keep the app runnable (`make up && make migrate && make dev`).
4. Every schema change ships with a **Knex migration**. Every business rule ships with **tests**.
5. Before declaring work done, run and pass:

```bash
npm run lint && npm run format:check && npm test && npm run build
```

```bash
npm run test:integration --workspace apps/api
```

6. Update the README, `.env.example` and API docs whenever setup, variables or endpoints change.
7. **Ask before implementing** anything ambiguous that affects patient safety, privacy, payroll
   correctness or legal compliance.

## Hard rules

- **Never commit secrets.** Only placeholders go in `.env.example`. Never put secrets in `VITE_*` variables.
- **Never invent** credentials, provider IDs, statutory rates, thresholds, effective dates or legal requirements.
- **Never hardcode statutory payroll values** (PF/EPS/ESI rates, wage ceilings, PT slabs, TDS slabs,
  gratuity rules). They live in effective-dated `statutory_rules` records with jurisdiction,
  `effective_from`/`effective_to`, `source_reference` and approval status.
- **Tenant isolation.** Every tenant-owned table has `organization_id` (and `branch_id` where it
  applies), with RLS **enabled and forced** in its migration (copy the policy from the Phase 2
  tenancy migration). Every repository query filters by the caller's tenant context **and** runs inside
  `withTenant(db, req.auth.organizationId, …)`. RLS is the second layer, never the only one. Use
  `withSystem()` only for pre-tenant lookups such as login; never in request handlers for tenant data.
  Add a cross-tenant test for every new module (`apps/api/tests/integration`).
- **Authorization on the backend.** Hiding something in the UI is not access control. Check permission
  and object ownership on every access to prevent IDOR.
- **Transactions** for booking, token generation, payroll finalization and anything that must be atomic.
- **Idempotency keys** for booking, token creation, webhook processing and payroll finalization.
- **Money** is `numeric` in PostgreSQL and handled as strings or decimal in JS. Never use JS floats for money.
- **Timestamps** are stored in UTC (`timestamptz`), alongside the organization/branch timezone.
- **IDs** are UUIDs (`gen_random_uuid()`).
- **Finalized payroll is immutable.** Corrections go through adjustment or reversal entries.
- **Never log** OTPs, passwords, tokens, bank details or full statutory identifiers (PAN, Aadhaar, UAN).
  Add new sensitive keys to `REDACT_PATHS` in `apps/api/src/core/logger.js`.
- **No real patient or employee data** in development, tests, fixtures, screenshots or demos.
- **Notifications** (SMS/WhatsApp) never include medical details by default. Use generic text and a secure link.
- **A phone number is a contact channel, not a patient identity.** Never auto-merge patients based on
  phone or name alone.
- **WhatsApp creates patient profiles only through its registration flow** (privacy notice first,
  family members pending staff check; see ADR 0010). It never creates one from a booking message.
- **Integrations go through adapters** (`apps/api/src/integrations/<kind>/`) so vendors can be swapped.

## Code conventions

- JavaScript with ES modules throughout, Node 22. Format with Prettier and lint with ESLint (flat config).
- API modules follow `apps/api/src/modules/README.md`: routes → service → repository. Business logic
  lives in services and SQL lives in repositories.
- Validate every request with zod at the route boundary.
- Throw `AppError(status, CODE, message)` for expected failures. The error middleware renders the envelope.
- Web code is organized by feature (`src/features/<feature>`) and fetches data with TanStack Query
  through `src/lib/api-client.js`.

## Useful commands

```bash
make up          # PostgreSQL + Redis
make migrate     # apply migrations
make dev         # API :4000 + web :5173
make test        # all tests
make lint        # eslint + prettier check
```
