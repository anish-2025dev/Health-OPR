# 0008: Authentication: sessions, staff and employee login

**Status:** Accepted (staff login done in Phase 2; employee OTP flows in Phases 8/9a)

## Context

Two kinds of people log in:

- **Staff with admin duties** (organization admin, HR, payroll, managers, receptionists, doctors).
- **Employees**, who mostly check in, view their own attendance, leave and payslips, and apply for leave.

The product owner asked for the option that is "best and easy to implement".

## Decision

### Sessions (everyone)

- Access token: a signed JWT lasting `ACCESS_TOKEN_EXPIRE_MINUTES` (default 15), holding the user id,
  organization id and session id. Roles and permissions are re-checked on the server for each request.
- Refresh session: an opaque random token in a `Secure; HttpOnly` cookie. Only its hash is stored
  (`auth_sessions`). It rotates on every use, and reuse of an old token revokes the whole session family.
- Logout and admin "revoke all sessions" delete sessions on the server.
- CSRF protection on cookie-authenticated, state-changing routes, and Redis-backed rate limits on login and OTP.
- The web app and API should be **same-site** so the refresh cookie isn't blocked as a third-party cookie.
  Use custom domains (for example `app.example.in` and `api.example.in`) or a same-origin `/api` rewrite.
  This is decided during Phase 2 deployment.

### Staff login: email + password

- Argon2id hashing, and a minimum length with a breached-password check where available.
- Admins invite users. There is no public sign-up.
- MFA (TOTP authenticator app) for owners, admins and payroll roles is planned as a follow-up, not a pilot blocker.

### Employees: OTP-based, no password

- **Sign-in:** mobile number + OTP, then the employee stays signed in on their phone (same session model
  as staff).
- **Marking attendance (pilot):** in the app, tap **Mark attendance**. The server first checks the phone's
  location against the branch geofence, and only then sends an SMS OTP. Attendance is recorded only if
  both pass. Full rules are in `docs/requirements/hr-attendance-leave-payroll.md` §2.3.
- **Self-service:** own attendance, leave and payslips, with the same sign-in.
- OTPs go through the SMS provider adapter (MSG91 or similar; development uses a console adapter that
  never sends real SMS). They are stored hashed, expire in 5 minutes, are single-use and rate-limited.
- OTP possession is not proof of identity on its own (spec rule). For attendance it is combined with the
  geofence check. Device binding, a rotating QR, or a check-in photo can be added later if proxy
  attendance turns out to be a problem.

## Consequences

- No SMS dependency for staff, so Phase 2 can start immediately.
- Each employee check-in and check-out sends one SMS, so attendance depends on the SMS provider being set up (DLT registration in India).
- A person who is both staff and an employee uses their staff login. Their self-service pages are the same.
