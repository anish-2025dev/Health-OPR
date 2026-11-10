# 0003: Express + React (Vite) in JavaScript

**Status:** Accepted (supersedes the spec's FastAPI + Next.js choice)

## Context

The original spec named FastAPI (Python) for the backend and Next.js for the frontend. The team then
chose a MERN-style stack so one language (JavaScript) covers the whole system, matching the team's skills
and speeding up the pilot.

## Decision

- **Backend:** Node.js 22, Express 5, ES modules, zod for validation, pino for logging, Knex + `pg`, ioredis.
  BullMQ for background jobs and `ws`/Socket.IO for realtime in later phases.
- **Frontend:** React 19 single-page app built with Vite, Tailwind CSS 4, TanStack Query, React Hook Form + zod
  (added with the first forms), React Router (added when a second page is needed).
  shadcn/ui-style components may be added as needed.
- **Testing:** Vitest everywhere, Supertest for HTTP, React Testing Library, and Playwright for E2E.

Vite is used instead of Next.js because this is an authenticated back-office SPA (plus a small public QR
registration portal), and it does not need server-side rendering. Keeping the web app static keeps
hosting simple, and all authorization stays in the API.

## Consequences

- One language and toolchain. Zod schemas can later be shared between API and web.
- No Pydantic/SQLAlchemy. The equivalents are zod and Knex.
- Any part of the spec that mentions FastAPI or Next.js should be read through this mapping.
