# Security baseline

Status markers: ✅ in place · 🔜 planned for the named phase.

## Transport & headers

- ✅ `helmet` security headers; `x-powered-by` disabled.
- ✅ CORS restricted to `FRONTEND_URL` (credentials allowed only for that origin).
- 🔜 (P13) HTTPS everywhere in deployed environments, with HSTS at the edge.

## Secrets & configuration

- ✅ `.env` is git-ignored and `.env.example` holds placeholders only.
- ✅ The API refuses to start in staging/production with a placeholder or short `APP_SECRET_KEY`.
- ✅ CI runs a gitleaks secret scan.
- Codespaces Secrets for development credentials, and a managed secret store in production.

## Logging

- ✅ Request logs hold only the request id, method, path and status.
- ✅ pino redaction for authorization/cookie headers and for password, OTP, token, bank and PAN/Aadhaar/UAN fields.
- ✅ Error responses never include stack traces or internal messages.

## Authentication (🔜 Phase 2)

- Argon2id password hashing.
- Short-lived access tokens, plus rotating refresh sessions stored server-side so they can be revoked.
- Cookies are `Secure`, `HttpOnly` and `SameSite`, with CSRF protection wherever cookie authentication is used.
- Rate limiting (Redis) on login, OTP and public registration endpoints.
- OTP proves possession of a phone, **not** identity or authority over a family member.

## Authorization (🔜 Phase 2)

- Role and permission checks on the backend for every route, plus object-level ownership checks (IDOR).
- Payroll approval and payroll payment are separate permissions.
- Employees see only their own HR self-service records.

## Data protection

- PostgreSQL RLS as defence in depth (see tenancy-model.md).
- Patient administrative data is separate from clinical records. Notifications carry no medical details.
- Sensitive identifiers are masked in the UI and logs. Documents go to object storage with metadata and
  ACLs in PostgreSQL.
- 🔜 Audit logs for sensitive reads/writes, admin actions and payroll changes.
- 🔜 (P13) Encrypted backups, tested restores, defined RPO/RTO.
- Synthetic data only in development and staging.

## Legal review required before production

DPDP Act and rules; clinical establishment and health record obligations; EPF/EPS/ESI/PT/TDS/gratuity and
state labour requirements; WhatsApp Business messaging policies; employment and leave rules.
