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

## Authentication (✅ staff login, Phase 2)

- ✅ Argon2id password hashing. Minimum 12 characters. Admin-created accounts get a one-time temporary
  password and must change it at first sign-in.
- ✅ 15-minute access tokens (kept in browser memory only), plus rotating refresh sessions stored as
  SHA-256 hashes so they can be revoked. Replaying an old refresh token revokes the whole session family.
- ✅ Refresh cookie is `HttpOnly`, `SameSite=Strict`, `Secure` outside development, scoped to
  `/api/v1/auth`. The web app and API are same-origin, and cookie routes also require a custom header (CSRF).
- ✅ Rate limiting (Redis) on login by IP and by email, plus account lockout after 5 failures for 15 minutes.
- ✅ The same error for unknown email and wrong password, with equalized timing.
- ✅ Every request re-checks the session, user and organization status, so logout, disable and password
  reset take effect immediately.
- ✅ Employee sign-in with mobile + SMS OTP (Phase 9a): 6-digit codes, HMAC-hashed at rest, 5-minute
  expiry, single use, 5 wrong attempts per code, 30-second cooldown, 5 codes per 15 minutes, and
  per-IP/per-mobile rate limits. The same response for registered and unregistered numbers. An OTP never
  opens an account that holds staff roles.
- ✅ Attendance: the geofence is checked before any OTP is sent; the OTP is verified and the punch saved
  atomically; failed attempts are audited; only distance, accuracy and the result are stored (no
  location history). OTPs are never logged (the console SMS adapter is refused outside development).
- 🔜 MFA (TOTP) for owners, admins and payroll roles.
- OTP proves possession of a phone, **not** identity or authority over a family member.

## Authorization (✅ Phase 2)

- ✅ Role and permission checks on the backend for every route. Object lookups are always scoped to the
  caller's organization (and branch, where relevant); other tenants' objects return 404.
- ✅ Branch-scoped roles. Only owners can grant or revoke the owner role, and nobody can change their own roles.
- 🔜 Payroll approval and payroll payment are separate permissions (Phase 10).
- ✅ Employee records: receptionists, doctors, nurses and employees have no access. Payroll and clinic
  managers can read them, but see masked mobile numbers and no emergency contacts. Only HR/admin can edit.
- 🔜 Employees see only their own HR self-service records (Phase 9a+).

## Data protection

- ✅ PostgreSQL RLS (forced, fails closed) as defence in depth (see tenancy-model.md). The API refuses
  to start in production with a superuser or `BYPASSRLS` database role.
- Patient administrative data is separate from clinical records. Notifications carry no medical details.
- Sensitive identifiers are masked in the UI and logs. Documents go to object storage with metadata and
  ACLs in PostgreSQL.
- ✅ Append-only audit log for sign-ins, failures, lockouts, password changes and admin actions
  (database trigger blocks update/delete). 🔜 Sensitive reads and payroll changes as those modules land.
- ✅ Authenticated API responses are sent with `Cache-Control: no-store`.
- 🔜 (P13) Encrypted backups, tested restores, defined RPO/RTO.
- Synthetic data only in development and staging.

## Legal review required before production

DPDP Act and rules; clinical establishment and health record obligations; EPF/EPS/ESI/PT/TDS/gratuity and
state labour requirements; WhatsApp Business messaging policies; employment and leave rules.
