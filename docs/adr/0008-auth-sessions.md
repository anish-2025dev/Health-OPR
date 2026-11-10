# 0008: Short-lived access tokens and rotating refresh sessions

**Status:** Proposed (to be confirmed in the Phase 2 plan)

## Proposal

- Passwords hashed with Argon2id.
- Access token: a signed JWT lasting `ACCESS_TOKEN_EXPIRE_MINUTES` (default 15), containing the user id,
  organization id and session id. Roles and permissions are re-checked server-side.
- Refresh session: an opaque random token in a `Secure; HttpOnly; SameSite=Strict` cookie. Only its hash is
  stored in PostgreSQL (`auth_sessions`). It rotates on every use, and reuse of an old token revokes the
  whole session family.
- Logout and admin "revoke all sessions" delete server-side sessions.
- CSRF protection on cookie-authenticated state-changing routes. Redis-backed rate limits on login and OTP.

## Open questions for Phase 2

- Is staff login by email + password enough for the pilot, or is phone OTP needed?
- Is MFA required for organization owners and payroll roles in the pilot?
