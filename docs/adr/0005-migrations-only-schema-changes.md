# 0005: Migrations are the only way to change schema

**Status:** Accepted

## Decision

- All schema changes go through Knex migrations in `apps/api/src/db/migrations` (`npm run db:make -- <name>`).
- The application never creates or alters tables at startup.
- Migrations are forward-only in production. `down` functions exist for local development.
- Destructive changes follow expand → migrate data → contract across separate releases.
- CI applies all migrations to a fresh database on every push.
- The Codespaces post-create script never runs migrations automatically against shared databases.

## Consequences

Schema history is reviewable and reproducible, and environments cannot drift silently.
