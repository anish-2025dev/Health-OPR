# HealthOS: Healthcare Operations OS

Multi-tenant B2B SaaS for hospitals, clinics and nursing homes in India. It covers patient registration,
appointments, queues, WhatsApp self-service for existing patients, and staff management, attendance,
leave and payroll.

> **Status:** Phase 0 + application foundation. The monorepo, dev environment, an Express API with
> health checks and a React web shell are in place. **There are no business features yet.**
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
make dev
```

4. Open the forwarded **5173** port (web). The API is on **4000**.

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
make dev
```

## Commands

| Command                     | What it does                                           |
| --------------------------- | ------------------------------------------------------ |
| `make up` / `make down`     | Start / stop PostgreSQL and Redis (data is kept)       |
| `make dev`                  | API on :4000 and web on :5173 with reload              |
| `make test`                 | All unit/integration tests                             |
| `make lint`                 | ESLint + Prettier check                                |
| `make migrate` / `rollback` | Apply / roll back database migrations                  |
| `npm run db:make -- <name>` | Create a new migration in `apps/api/src/db/migrations` |
| `npm run build`             | Production build of the web app                        |

## API

Base path: `/api/v1`. JSON only.

| Endpoint                   | Purpose                                                |
| -------------------------- | ------------------------------------------------------ |
| `GET /api/v1/health`       | Liveness: `{"status":"ok"}`                            |
| `GET /api/v1/health/ready` | Readiness: checks PostgreSQL and Redis; `200` or `503` |

Errors always use one envelope with a machine-readable code:

```json
{ "error": { "code": "ROUTE_NOT_FOUND", "message": "No route for GET /x", "requestId": "…" } }
```

Each response carries an `x-request-id` header for tracing.

## Environment variables

Every variable is listed with a placeholder in [`.env.example`](.env.example). Copy it to `.env` (git
ignores that file). **Never commit `.env` or real credentials.** In Codespaces, set real development
credentials as **Codespaces Secrets**. In production, use a managed secret store.

| Variable                                                                | Used by | Notes                                                                                   |
| ----------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `APP_ENV`                                                               | API     | `development`, `test`, `staging`, `production`                                          |
| `APP_SECRET_KEY`                                                        | API     | Signing secret. Must be ≥ 32 real chars outside dev; the API refuses to start otherwise |
| `API_PORT`                                                              | API     | Default 4000. A platform-provided `PORT` (Render) takes precedence                      |
| `FRONTEND_URL`                                                          | API     | Allowed CORS origin; must be `https://` outside dev                                     |
| `ACCESS_TOKEN_EXPIRE_MINUTES` / `REFRESH_TOKEN_EXPIRE_DAYS`             | API     | Auth session lifetimes (Phase 2)                                                        |
| `LOG_LEVEL`                                                             | API     | pino level                                                                              |
| `DATABASE_URL`                                                          | API     | PostgreSQL connection string; needs `?sslmode=require` outside dev                      |
| `DATABASE_MIGRATION_URL`                                                | API     | Optional direct (non-pooled) URL for migrations; falls back to `DATABASE_URL`           |
| `REDIS_URL`                                                             | API     | Redis connection string                                                                 |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_PORT` | Compose | Local database container                                                                |
| `REDIS_PORT`                                                            | Compose | Local Redis container                                                                   |
| `VITE_API_BASE_URL`                                                     | Web     | Public; never put secrets in `VITE_*`                                                   |
| `WHATSAPP_*`, `MSG91_*`, `S3_BUCKET`, `AWS_REGION`                      | API     | Integrations in later phases; leave empty for now                                       |

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
