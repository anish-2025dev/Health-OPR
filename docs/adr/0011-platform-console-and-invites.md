# ADR 0011: Platform console and invite links for onboarding hospitals

- Status: Accepted
- Date: 2026-11-13

## Context

Hospitals were created with a server command (`org:create`) that printed a temporary password for the
owner. The operator needs a screen to onboard hospitals, see who is active, help owners who are locked
out, and suspend a hospital (for example, when a contract is paused), without anyone handling
passwords.

## Decision

1. **Platform admins are a separate kind of account** (`platform_admins`). They have their own login
   at `/platform`, their own token audience and key, and their own refresh cookie path. A platform
   token is rejected by every hospital API, and a hospital token is rejected by the platform API. The
   first platform admin is created from the server shell with `npm run platform:admin`. A temporary
   password is printed, and it must be changed at first sign-in.
2. **Owners are invited, never given passwords.** Creating a hospital creates the owner with no
   password and returns a one-time invite link (7 days). Only a SHA-256 hash of the link is stored.
   Opening the link lets the owner set a password, and signs them in. A new link revokes earlier
   unused links, which also serves as "forgot password" for owners.
3. **The console sees counts, not records.** Hospital list and detail show branch, staff, employee and
   patient counts, and owner name, email and last sign-in. No patient or employee details are exposed.
   These reads are cross-tenant by nature, so they run in the system context and return aggregates
   only.
4. **Suspension** sets the organization to `suspended`, ends all its sessions and blocks sign-in until
   reactivated. Data is untouched.
5. **Every console action is audited** in `platform_audit_logs`, and also in the hospital's own audit
   log when it affects that hospital.

## Consequences

- Onboarding no longer needs server access, apart from creating platform admins.
- The `org:create` command remains for scripted setups and local development.
- The console is served from the staff website at `/platform`. It could move to its own address later
  without API changes.
