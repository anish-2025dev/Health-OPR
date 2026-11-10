# 0008: Authentication: sessions, staff and employee login

**Status:** Accepted (staff login in Phase 2; employee mobile login in Phase 8/9a)

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

### Employee login: mobile number + OTP, with one registered phone

- An employee is identified by the mobile number HR enters on their profile. The OTP goes through the
  SMS provider adapter (MSG91 or similar; development uses a console adapter that never sends real SMS).
- The first successful login registers that phone (a device key kept on the phone). Attendance check-in
  is accepted only from the registered phone.
- Registering a new phone needs an OTP **and** HR approval.
- **Until the SMS provider and DLT registration are ready**, HR can generate a one-time activation code
  (short expiry, single use, audit-logged) and give it to the employee in person.
- OTP possession is not proof of identity on its own (spec rule). It is combined with device registration
  and the anti-proxy checks in `docs/requirements/hr-attendance-leave-payroll.md` §2.3.

## Consequences

- No SMS dependency for staff, so Phase 2 can start immediately.
- Employee check-in has no per-punch SMS cost.
- A person who is both staff and an employee uses their staff login. Their self-service pages are the same.
