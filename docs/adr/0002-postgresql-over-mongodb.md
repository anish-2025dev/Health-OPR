# 0002: PostgreSQL rather than MongoDB

**Status:** Accepted

## Context

The team asked for a MERN-style stack and for the database to be chosen between PostgreSQL and MongoDB
based on the requirements. Requirements from the spec that bear on this choice:

- Transactional token generation, booking and payroll finalization, with concurrency safety
  ("concurrent bookings do not issue duplicate tokens").
- Strict multi-tenant isolation, with database-enforced defence in depth.
- Highly relational data: organizations → branches → departments/doctors; contacts ↔ patients (many to
  many, with authorization status); appointments → queue entries → tokens; employees → attendance,
  leave, shifts, salary structures → payroll runs → payroll items → statutory rule versions.
- Money must use exact decimal types. Payroll must be reproducible and auditable, and finalized payroll
  must be immutable.
- Unique constraints scoped per tenant, and effective-dated rules with non-overlapping ranges.
- Reporting and analytics across these relations.

## Decision

Use **PostgreSQL** as the system of record.

| Need                            | PostgreSQL                                                       | MongoDB                                                                   |
| ------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Multi-row ACID transactions     | Native, mature; `SELECT … FOR UPDATE`, advisory locks            | Supported (replica set required), but more constrained and less idiomatic |
| Tenant isolation in the DB      | **Row-level security** policies                                  | No equivalent; application-only                                           |
| Relational integrity            | Foreign keys, composite FKs including `organization_id`          | Manual / application-enforced                                             |
| Exact money                     | `numeric`                                                        | `Decimal128` (workable, weaker tooling in JS)                             |
| Non-overlapping effective dates | Exclusion constraints on `daterange`                             | Application-enforced                                                      |
| Reporting / joins               | SQL, window functions, materialized views                        | Aggregation pipelines                                                     |
| Flexible fields                 | `jsonb` (for example `calculation_snapshot`, rule configuration) | Native                                                                    |

The few genuinely document-shaped parts (WhatsApp conversation state, payroll calculation snapshots,
statutory rule configuration) fit well in `jsonb` columns.

## Consequences

- The stack is effectively **PERN** (PostgreSQL, Express, React, Node) rather than MERN. Everything
  else about the MERN approach (JavaScript end to end, Express, React) is unchanged.
- We use Knex as a query builder and migration tool, keeping SQL explicit, which suits RLS,
  `set_config` and locking. An ORM can be reconsidered later if needed.
- Developers need basic SQL and migration discipline.
