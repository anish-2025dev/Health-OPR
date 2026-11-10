# HealthOS: Healthcare Operations OS

Multi-tenant B2B SaaS for hospitals, clinics and nursing homes in India. It covers patient registration,
appointments, queues, WhatsApp self-service for existing patients, and staff management, attendance,
leave and payroll.

> **Status:** Phases 0–2, 8 and 9a complete: multi-tenant foundation, organization structure,
> employees, and **attendance** (employee mobile + OTP sign-in, "Mark attendance" with geofence + SMS
> OTP, rules, dashboard, register, corrections, CSV export). Leave (9b) and payroll (10) are next.
> Use synthetic data only.

The primary requirements document is
[`docs/healthos-platform-project-spec.json`](docs/healthos-platform-project-spec.json). Where the
codebase deliberately departs from it (for example the MERN-style stack), an ADR in
[`docs/adr`](docs/adr) records why.

## Stack

| Layer      | Choice                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| Frontend   | React 19 + Vite (JavaScript), Tailwind CSS 4, TanStack Query                                                      |
| Backend    | Node.js 22 + Express 5 (JavaScript, ES modules), zod validation, pino logging                                     |
| Database   | **PostgreSQL 17** via Knex (migrations + query builder). See [ADR 0002](docs/adr/0002-postgresql-over-mongodb.md) |
| Cache/jobs | Redis 7 (BullMQ for background jobs in later phases)                                                              |
| Tests      | Vitest, Supertest, React Testing Library (Playwright for E2E in later phases)                                     |
| Dev env    | GitHub Codespaces devcontainer + Docker Compose                                                                   |
| CI         | GitHub Actions: lint, format, tests, build, migrations + readiness smoke test, secret scan                        |

## Repository layout

```
.
├── apps/
│   ├── api/                 # Express API (modular monolith)
│   │   ├── src/
│   │   │   ├── api/v1/      # versioned routers mounted at /api/v1
│   │   │   ├── config/      # validated environment config
│   │   │   ├── core/        # db, redis, logger, errors, middleware
│   │   │   ├── db/migrations/
│   │   │   └── modules/     # business modules (added phase by phase)
│   │   └── tests/
│   └── web/                 # React + Vite SPA
│       └── src/{app,components,features,lib,hooks,styles}
├── docs/                    # spec, architecture notes, ADRs
├── infrastructure/          # deployment config (later phases)
├── scripts/                 # developer scripts
├── .devcontainer/           # Codespaces configuration
├── .github/workflows/       # CI
├── docker-compose.yml       # PostgreSQL + Redis for local/Codespaces only
└── Makefile
```

## Getting started

### In GitHub Codespaces (recommended)

1. **Code → Codespaces → Create codespace on main.** Pick a 4-core machine if you'll run everything at once.
2. The devcontainer creates `.env` from `.env.example`, runs `npm ci` and starts PostgreSQL and Redis.
3. Run:

```bash
make migrate
```

```bash
npm run org:create --workspace apps/api -- --name "Demo Clinic" --slug demo-clinic --owner-email owner@demo.test --owner-name "Demo Owner"
```

```bash
make dev
```

4. Open the forwarded **5173** port and sign in with the owner email and the temporary password printed
   by `org:create`. You'll be asked to set your own password. The web dev server proxies `/api` to the
   API on **4000**.

### Locally

Requires Node 22+ and Docker.

```bash
make setup
```

```bash
make up
```

```bash
make migrate
```

```bash
npm run org:create --workspace apps/api -- --name "Demo Clinic" --slug demo-clinic --owner-email owner@demo.test --owner-name "Demo Owner"
```

```bash
make dev
```

> **Upgrading from Phase 0/1?** The local database now uses a separate non-superuser role for the API
> (row-level security doesn't apply to superusers). Copy the new `POSTGRES_*` and `DATABASE_URL` values from
> `.env.example` into `.env`, then recreate the local volume once (this deletes local dev data):
>
> ```bash
> docker compose down -v
> ```

## Commands

| Command                                         | What it does                                               |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `make up` / `make down`                         | Start / stop PostgreSQL and Redis (data is kept)           |
| `make dev`                                      | API on :4000 and web on :5173 with reload                  |
| `make test`                                     | Unit tests (no database needed)                            |
| `npm run test:integration --workspace apps/api` | API integration tests against PostgreSQL (`make up` first) |
| `npm run org:create --workspace apps/api -- …`  | Create an organization, main branch and owner account      |
| `make lint`                                     | ESLint + Prettier check                                    |
| `make migrate` / `rollback`                     | Apply / roll back database migrations                      |
| `npm run db:make -- <name>`                     | Create a new migration in `apps/api/src/db/migrations`     |
| `npm run build`                                 | Production build of the web app                            |

## API

Base path: `/api/v1`. JSON only.

| Endpoint                                                                            | Auth / permission                                 | Purpose                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /health`                                                                       | public                                            | Liveness: `{"status":"ok"}`                                                |
| `GET /health/ready`                                                                 | public                                            | Readiness: checks PostgreSQL and Redis; `200` or `503`                     |
| `POST /auth/login`                                                                  | public, rate-limited                              | Email + password → access token + refresh cookie                           |
| `POST /auth/refresh`                                                                | refresh cookie + `X-Requested-With: healthos-web` | Rotate refresh token, new access token                                     |
| `POST /auth/logout`                                                                 | refresh cookie + header                           | End the session                                                            |
| `GET /auth/me`                                                                      | signed in                                         | User, organization, roles, permissions, branch scope                       |
| `POST /auth/change-password`                                                        | signed in                                         | Change own password; signs out other sessions                              |
| `GET /organizations/current`                                                        | signed in                                         | Current organization                                                       |
| `PATCH /organizations/current`                                                      | `organization.manage`                             | Update name, legal name, timezone                                          |
| `GET /branches`                                                                     | `branches.read`                                   | Branches (limited to the user's branch scope)                              |
| `POST /branches`, `PATCH /branches/:id`                                             | `branches.manage`                                 | Create / update / deactivate a branch                                      |
| `GET /users`, `GET /users/roles`                                                    | `users.read`                                      | Staff users with roles; role catalog                                       |
| `POST /users`                                                                       | `users.manage`                                    | Create a user; returns a one-time temporary password                       |
| `PATCH /users/:id`                                                                  | `users.manage`                                    | Update name/phone, enable/disable (ends sessions)                          |
| `PUT /users/:id/roles`                                                              | `users.manage`                                    | Replace role assignments                                                   |
| `POST /users/:id/reset-password`                                                    | `users.manage`                                    | New temporary password; ends sessions                                      |
| `GET /audit-logs?limit&before&action`                                               | `audit.read`                                      | Audit entries, newest first                                                |
| `GET /departments`, `/designations`, `/shifts`                                      | `employees.read` or `org_structure.manage`        | Lookup lists                                                               |
| `POST`/`PATCH` `/departments`, `/designations`, `/shifts`                           | `org_structure.manage`                            | Create, rename, deactivate                                                 |
| `GET /holidays?year&branchId`                                                       | `holidays.read`                                   | Holiday calendar (branch filter includes organization-wide holidays)       |
| `POST /holidays`, `DELETE /holidays/:id`                                            | `org_structure.manage`                            | Manage holidays                                                            |
| `GET /hr/employees?q&branchId&departmentId&status&limit&offset`                     | `employees.read`                                  | Employees (branch-scoped; mobile masked without `employees.manage`)        |
| `GET /hr/employees/:id`                                                             | `employees.read`                                  | One employee                                                               |
| `POST /hr/employees`, `PATCH /hr/employees/:id`                                     | `employees.manage`                                | Create (auto `EMP-0001` IDs) / update, including exit                      |
| `PATCH /branches/:id` with `location`, `geofenceRadiusM`                            | `branches.manage`                                 | Branch attendance location and radius                                      |
| `POST /auth/employee/request-otp` `{company, mobile}`                               | public, rate-limited                              | Sends a sign-in OTP if the number is registered (same response either way) |
| `POST /auth/employee/verify-otp` `{company, mobile, code}`                          | public, rate-limited                              | Employee sign-in → access token + refresh cookie                           |
| `GET /me/attendance/today`                                                          | employee                                          | Today's status and next action (check in / check out)                      |
| `POST /me/attendance/start` `{latitude, longitude, accuracy}`                       | employee                                          | Geofence check; sends an attendance OTP only if inside                     |
| `POST /me/attendance/confirm` `{challengeId, code}`                                 | employee                                          | Verifies the OTP and records the punch                                     |
| `GET /me/attendance?month=YYYY-MM`                                                  | employee                                          | Own month: days, summary, late entries, late penalty, holidays             |
| `GET`/`POST /me/attendance/regularizations`, `POST …/:id/cancel`                    | employee                                          | Own correction requests                                                    |
| `GET`/`PUT /attendance/policy`                                                      | `attendance.read` / `attendance.manage`           | Attendance rules (hours, grace, late penalty, OT)                          |
| `GET /attendance/dashboard?date`                                                    | `attendance.read`                                 | Totals, by department, late arrivals, holidays                             |
| `GET /attendance/register?date&branchId&departmentId`                               | `attendance.read`                                 | Daily register                                                             |
| `GET /attendance/employees/:id/month?month`                                         | `attendance.read`, the employee, or their manager | Month view                                                                 |
| `PUT /attendance/employees/:id/days/:date` `{status?, checkIn?, checkOut?, reason}` | `attendance.manage`                               | Manual correction (reason required, audited)                               |
| `GET /attendance/regularizations?status`, `POST …/:id/approve`, `POST …/:id/reject` | `attendance.manage` or reporting manager          | Decide correction requests                                                 |
| `GET /attendance/team?month`                                                        | reporting managers                                | Direct reports' monthly summary                                            |
| `GET /attendance/export?month&branchId`, `GET /attendance/holidays/export?year`     | `attendance.read` / `holidays.read`               | CSV exports                                                                |

All paths are under `/api/v1`. Signed-in requests send `Authorization: Bearer <accessToken>`.

Errors always use one envelope with a machine-readable code:

```json
{ "error": { "code": "ROUTE_NOT_FOUND", "message": "No route for GET /x", "requestId": "…" } }
```

Each response carries an `x-request-id` header for tracing.

## Environment variables

Every variable is listed with a placeholder in [`.env.example`](.env.example). Copy it to `.env` (git
ignores that file). **Never commit `.env` or real credentials.** In Codespaces, set real development
credentials as **Codespaces Secrets**. In production, use a managed secret store.

| Variable                                                                        | Used by | Notes                                                                                        |
| ------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `APP_ENV`                                                                       | API     | `development`, `test`, `staging`, `production`                                               |
| `APP_SECRET_KEY`                                                                | API     | Signing secret. Must be ≥ 32 real chars outside dev; the API refuses to start otherwise      |
| `API_PORT`                                                                      | API     | Default 4000. A platform-provided `PORT` (Render) takes precedence                           |
| `FRONTEND_URL`                                                                  | API     | Allowed CORS origin; must be `https://` outside dev                                          |
| `ACCESS_TOKEN_EXPIRE_MINUTES` / `REFRESH_TOKEN_EXPIRE_DAYS`                     | API     | Auth session lifetimes (Phase 2)                                                             |
| `LOG_LEVEL`                                                                     | API     | pino level                                                                                   |
| `DATABASE_URL`                                                                  | API     | PostgreSQL connection string; needs `?sslmode=require` outside dev                           |
| `DATABASE_MIGRATION_URL`                                                        | API     | Optional direct (non-pooled) URL for migrations; falls back to `DATABASE_URL`                |
| `REDIS_URL`                                                                     | API     | Redis connection string                                                                      |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_PORT`         | Compose | Local database container (superuser, admin only)                                             |
| `POSTGRES_APP_USER` / `POSTGRES_APP_PASSWORD`                                   | Compose | Non-superuser role the API connects as locally                                               |
| `SMS_PROVIDER`, `MSG91_AUTH_KEY`, `MSG91_OTP_TEMPLATE_ID`, `MSG91_OTP_VARIABLE` | API     | Employee OTP SMS. `console` locally (OTP printed in the API terminal); `msg91` when deployed |
| `TEST_DATABASE_URL`                                                             | Tests   | Optional; integration tests default to `DATABASE_URL` with database `healthos_test`          |
| `REDIS_PORT`                                                                    | Compose | Local Redis container                                                                        |
| `VITE_API_BASE_URL`                                                             | Web     | Default `/api/v1` (same origin). Public; never put secrets in `VITE_*`                       |
| `WHATSAPP_*`, `MSG91_*`, `S3_BUCKET`, `AWS_REGION`                              | API     | Integrations in later phases; leave empty for now                                            |

## Deployment

Hosting is **Render** (API web service, static web app, private Key Value/Redis) with **Neon** for
PostgreSQL, defined in [`render.yaml`](render.yaml). Step-by-step instructions are in
[`docs/deployment/render-neon.md`](docs/deployment/render-neon.md).

## Roadmap

See [`docs/roadmap.md`](docs/roadmap.md). Phases are delivered one at a time, each approved before work starts.

## Compliance note

The software provides configurable controls for privacy (DPDP Act), healthcare records and Indian
payroll statutes (EPF/EPS, ESI, PT, LWF, TDS, gratuity). **It does not by itself guarantee legal
compliance.** Statutory rates are never hardcoded, and qualified Indian legal and payroll review is
required before production use.
