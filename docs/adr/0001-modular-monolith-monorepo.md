# 0001: Modular monolith in a monorepo

**Status:** Accepted

## Context

A small team needs to ship a pilot fast while the domain (patients, queues, HR, payroll) is still being
learned. Microservices would add deployment, network and data-consistency costs without any current
benefit.

## Decision

- One repository with npm workspaces: `apps/api` (Express) and `apps/web` (React).
- One deployable API, internally split into modules (`apps/api/src/modules/<name>`). Each module has
  routes → service → repository layers and a public `index.js`.
- A separate worker process (same codebase) for background jobs once they are needed.

## Consequences

- Simple local development, one CI pipeline, and ACID transactions across modules.
- Boundaries are kept by convention and review: modules import each other only through `index.js`.
- If a module later needs independent scaling, its clean boundary lets it be extracted.
