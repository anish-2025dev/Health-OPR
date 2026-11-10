# Architecture decision records

| ADR                                             | Decision                                                          | Status             |
| ----------------------------------------------- | ----------------------------------------------------------------- | ------------------ |
| [0001](0001-modular-monolith-monorepo.md)       | Modular monolith in an npm-workspaces monorepo                    | Accepted           |
| [0002](0002-postgresql-over-mongodb.md)         | PostgreSQL rather than MongoDB                                    | Accepted           |
| [0003](0003-javascript-express-react-stack.md)  | Express + React (Vite) in JavaScript instead of FastAPI + Next.js | Accepted           |
| [0004](0004-shared-schema-tenancy-with-rls.md)  | Shared-schema multi-tenancy with RLS                              | Accepted           |
| [0005](0005-migrations-only-schema-changes.md)  | Knex migrations are the only way to change schema                 | Accepted           |
| [0006](0006-provider-adapters.md)               | Provider adapters for all external integrations                   | Accepted           |
| [0007](0007-effective-dated-statutory-rules.md) | Effective-dated, versioned statutory payroll rules                | Accepted           |
| [0008](0008-auth-sessions.md)                   | Short-lived access tokens + rotating refresh sessions             | Proposed (Phase 2) |

New ADRs use the next number and the format: Context, Decision, Consequences.
