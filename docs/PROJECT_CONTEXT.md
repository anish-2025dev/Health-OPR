# HealthOS: complete project context

**Read this first.** It is the single source of truth for what HealthOS is, what has been built, the
decisions taken and why, and where everything lives. It was written from the code and Git history
(not from memory), on 2026-11-13, at commit `38efeda`.

If this file and the code ever disagree, **the code wins**: fix this file in the same change. Update it
whenever a feature, decision, setting or deployment fact changes.

---

## 1. What HealthOS is

A multi-tenant SaaS for hospitals, clinics and nursing homes in **India**. One deployment serves many
hospitals ("organizations"), each completely isolated. It covers two halves:

- **Clinic side:**
  - patient registration (reception, patient website, WhatsApp);
  - family members on one phone, duplicate review, privacy notices and consent;
  - doctors and schedules, appointments, walk-ins, tokens, live queue, patient tracking link and
    waiting-room display;
  - clinic dashboard, analytics.
- **Staff side:**
  - employees and company structure;
  - attendance (geofence + SMS OTP), leave;
  - payroll from attendance, statutory rules, payslips;
  - messages to employees, workforce analytics.

Plus a **platform console** for the operator's own team to onboard hospitals.

Status: **pilot build**. Synthetic data only, until the legal, payroll and SMS items in §13 are done.

## 2. People, repository, deployment

| Item                     | Value                                                                                                                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository               | `github.com/anish-2025dev/health-opr` (branch `main`). The original spec mentioned `Negi270804/Hlt-OPR`, which was inaccessible                                                                                                                                      |
| Product owner            | The user in the build conversations (account owner of the repo)                                                                                                                                                                                                      |
| Teammate seen in history | **Nikhil Negi**: edited `render.yaml` directly on GitHub (free plan, migrations in build, API URL `healthos-api-gjr1`)                                                                                                                                               |
| Hosting                  | **Render** (Singapore): `healthos-api` (Node, **free plan**), `healthos-web` (static, staff/employee app), `healthos-patient` (static, patient website), `healthos-redis` (Key Value, free)                                                                          |
| Database                 | **Neon PostgreSQL 17** (Singapore). App role `healthos_app` (NOBYPASSRLS), pooled `DATABASE_URL`, direct `DATABASE_MIGRATION_URL`                                                                                                                                    |
| Live API URL             | `https://healthos-api-gjr1.onrender.com` (both static sites rewrite `/api/*` to it)                                                                                                                                                                                  |
| Live web URLs            | Assigned by Render; not recorded in the repo. Check the Render dashboard                                                                                                                                                                                             |
| CI                       | GitHub Actions `.github/workflows/ci.yml`: lint, format, unit tests, build; services job (migrations, integration tests, readiness smoke); **gitleaks** secret scan (config `.gitleaks.toml`). Render deploys only after CI passes (`autoDeployTrigger: checksPass`) |

**Manual steps pending after the last push** (owner must do in Render; see §12):

1. `npm run platform:admin` in the API Shell.
2. Sync the Blueprint to create `healthos-patient`.
3. Set `PATIENT_SITE_URL` (API) and `VITE_PATIENT_SITE_URL` (web).

## 3. Product decisions made by the owner (do not silently reverse)

| Decision                                                                                                                                                                                                                                           | Where recorded                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Stack: "MERN-style" but **PostgreSQL** chosen over MongoDB (relational, RLS, money, transactions) → effectively PERN                                                                                                                               | ADR 0002, 0003                                          |
| Deploy on **Render + Neon**                                                                                                                                                                                                                        | `render.yaml`, `docs/deployment/render-neon.md`         |
| **Attendance**: no QR. Employee opens app → taps Check in → server verifies phone location inside branch radius (**default 10 m**, per branch) → SMS OTP to the employee's own mobile → saved only if **both** pass. First mark = in, second = out | `docs/requirements/hr-attendance-leave-payroll.md` §2.3 |
| Logins: staff = **email + password**; employees = **company code + mobile + OTP** (account auto-created on first OTP sign-in); patients = **phone + OTP** on the patient website                                                                   | ADR 0008, 0009                                          |
| HR and clinic built **in parallel**; **day rate basis chosen by admin** (calendar / working / fixed days); **leave approval levels configurable per leave type** (1 or 2)                                                                          | HR requirements doc                                     |
| Employees see their own OT, leave, late entries, holidays, half days; admins configure deductions/policies; payslips from attendance (late + half-day deductions)                                                                                  | HR requirements doc                                     |
| **No statutory rates hardcoded**; the org's adviser enters and approves effective-dated rules                                                                                                                                                      | ADR 0007                                                |
| Medical history / clinical notes: **out of scope for the pilot**                                                                                                                                                                                   | This file                                               |
| **Patient website on its own address**; one patient account can join many hospitals with each hospital's code (once); each hospital keeps its own records. **Cross-hospital history sharing is a future, consent-based feature, not built**        | ADR 0009                                                |
| **WhatsApp may register patients** (owner reversed the original "never creates profiles" rule on 2026-11-13), with privacy notice first and family members pending staff check                                                                     | ADR 0010                                                |
| **Platform console** for onboarding hospitals with one-time owner invite links                                                                                                                                                                     | ADR 0011                                                |
| **Bulk employee upload** from Excel/CSV                                                                                                                                                                                                            | `docs/api.md`                                           |
| Push policy: **confirm with the owner before every push to GitHub** (pushes trigger Render deploys)                                                                                                                                                | Conversation rule                                       |

## 4. Architecture in one page

```
apps/api   Node 22, Express 5, ESM JavaScript, zod, pino, Knex + pg, ioredis, jose (JWT),
           @node-rs/argon2, pdfkit (payslips), yazl (ZIP). Modular monolith: routes → service → SQL.
apps/web   React 19, Vite 8, Tailwind 4, TanStack Query, react-router 8, qrcode, read-excel-file.
           ONE codebase, THREE surfaces:
             staff/employee app   (default build → dist/)       also serves /platform and /invite
             patient website      (VITE_APP_SURFACE=patient → dist-patient/; contains no staff code)
           Root.jsx lazy-loads the right surface; each build ships only its own code.
Postgres   Shared tables + organization_id + FORCED row-level security on every tenant table.
Redis      Rate limits only (fails open; DB lockouts still protect logins).
```

**Tenancy (the most important rule):**

- Every tenant table has `organization_id`, with RLS **enabled and forced**. The policy is
  `app.rls_bypass='on' OR organization_id = app.current_organization_id`.
- Handlers run queries in `withTenant(db, orgId, fn)`, which sets the transaction-local tenant id, and
  **also** filter by `organization_id` in SQL.
- `withSystem()` (bypass) is only for pre-tenant lookups: login by email, refresh token,
  organization by code, patient tracking code, WhatsApp number → hospital, invite token. It is also
  used for platform-level tables (patient accounts, platform console aggregates) and the WhatsApp
  retry sweep.
- The API refuses to start in production as a superuser or BYPASSRLS database role.

**Four separate kinds of login.** Each has its own token audience and key, and they are not
interchangeable:

| Who                        | How                                        | Token / cookie                                                                                                         |
| -------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Hospital staff & employees | email+password, or company code+mobile+OTP | aud `healthos`, cookie `hos_refresh` (path `/api/v1/auth`), 15-min access token, rotating refresh with reuse detection |
| Patients                   | phone + OTP on patient website             | aud `healthos-patient`, cookie `hos_patient_refresh` (path `/api/v1/patient-auth`), 30 days                            |
| Platform admins (operator) | email+password at `/platform`              | aud `healthos-platform`, cookie `hos_platform_refresh` (path `/api/v1/platform/auth`), 7 days                          |
| Patient tracking link      | unguessable 16-char code in URL, no login  | shows token/position only, never names                                                                                 |

CSRF: cookie-based endpoints require the header `X-Requested-With: healthos-web`.

## 5. Database migrations (`apps/api/src/db/migrations`)

| #   | File                        | Adds                                                                                                                                                  |
| --- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | tenancy_foundation          | organizations, branches, users, user_role_assignments, auth_sessions, audit_logs (append-only)                                                        |
| 2   | org_structure_and_employees | departments, designations, shifts, holidays, employees; branch lat/long + `geofence_radius_m` (default 10)                                            |
| 3   | attendance                  | otp_challenges, attendance_policies, attendance_punches, attendance_days, attendance_regularizations                                                  |
| 4   | leave                       | leave_types, leave_balance_adjustments, leave_requests                                                                                                |
| 5   | payroll                     | payroll_settings, salary_components, salary_structures(+lines), pay_policies, payroll_runs, payroll_items, payroll_adjustments; immutability triggers |
| 6   | statutory                   | statutory_rules (immutable when approved), employee_statutory                                                                                         |
| 7   | patients_consent            | patient_settings, privacy_notice_versions, contacts, patients, contact_patient_links, consents, patient_duplicate_flags, data_principal_requests      |
| 8   | appointments_queue          | doctors, doctor_schedules, doctor_time_off, appointments, queue_counters, queue_entries                                                               |
| 9   | patient_accounts            | patient_accounts, patient_account_otps, patient_account_sessions, patient_account_clinics (platform-level, no tenant RLS)                             |
| 10  | whatsapp_notifications      | whatsapp_channels, whatsapp_inbound_events, whatsapp_conversations, notification_log                                                                  |
| 11  | employee_messages           | employee_messages, employee_message_recipients                                                                                                        |
| 12  | platform_admin              | platform_admins, platform_sessions, platform_audit_logs, user_invites (tenant RLS)                                                                    |
| 13  | whatsapp_registration       | allows `whatsapp` as patient registration / link channel                                                                                              |

IDs are UUIDs; money is `numeric` and handled as strings or BigInt paise; timestamps are `timestamptz`;
`date` columns come back as `'YYYY-MM-DD'` strings (pg type parser).

## 6. API map (`/api/v1`; full list in `docs/api.md`)

| Mount                                                  | Module (`apps/api/src/modules/…`)            | Purpose                                                                                                          |
| ------------------------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/health`                                              | `api/v1/health.routes.js`                    | liveness `/health`, readiness `/health/ready`                                                                    |
| `/auth`                                                | authentication                               | staff login/refresh/logout/me/change-password; employee OTP login; **invite** `/invite/:token`, `/invite/accept` |
| `/organizations`, `/branches`, `/users`, `/audit-logs` | organizations, branches, staff-access, audit | org settings, branches + geofence, users & roles, audit                                                          |
| `/departments` `/designations` `/shifts` `/holidays`   | org-structure                                | company structure                                                                                                |
| `/hr/employees` (+ `/import`)                          | hr-employees                                 | employees; **bulk upload**                                                                                       |
| `/attendance`, `/me`                                   | hr-attendance                                | admin attendance; self attendance (start → OTP → confirm)                                                        |
| `/leave`, `/me/leave`                                  | hr-leave                                     | leave admin; own leave                                                                                           |
| `/payroll`, `/payroll/statutory`, `/me/payslips`       | hr-payroll, hr-statutory                     | payroll runs, payslips PDF/ZIP/CSV, statutory rules                                                              |
| `/messages`, `/me/messages`                            | messages                                     | messages to employees; inbox                                                                                     |
| `/patients`, `/privacy`                                | patients                                     | patients, contacts/family links, consent; notices, duplicates, data requests, matching settings                  |
| `/doctors`, `/appointments`, `/queue`                  | clinic                                       | schedules, slots, booking, walk-ins, queue actions, summary, visits                                              |
| `/analytics`                                           | analytics                                    | `/workforce`, `/clinic`                                                                                          |
| `/integrations`                                        | whatsapp                                     | hospital WhatsApp number, notification log                                                                       |
| `/webhooks/whatsapp`                                   | whatsapp                                     | Meta webhook (signature-verified)                                                                                |
| `/platform`                                            | platform                                     | operator console (separate login)                                                                                |
| `/patient-auth`, `/patient`                            | patient-accounts                             | patient sign-in; my hospitals / join by code                                                                     |
| `/public/clinics/:code/…`                              | patients/portal.routes.js                    | patient website per hospital: profiles, consent, privacy requests, doctors, slots, booking, cancel               |
| `/public/track/:code`                                  | clinic                                       | live tracking link                                                                                               |

Other building blocks:

- `integrations/sms`: adapters `msg91` (Flow API), `console` (dev: prints OTPs to the API
  terminal) and `memory` (tests).
- `integrations/whatsapp`: adapters `meta` (Cloud API), `console` and `memory`.
- `modules/otp`: employee OTPs, HMAC-hashed.
- `modules/notifications`: consent-aware appointment confirmations (WhatsApp template → SMS →
  none), logged.

## 7. Roles and permissions (`modules/staff-access/permissions.js`)

| Role                                   | Permissions                                                                                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| organization_owner, organization_admin | everything                                                                                                                                                                          |
| clinic_manager                         | branches.read, users.read, holidays.read, employees.read, attendance.read, leave.read, patients.read/manage, privacy.manage, doctors.manage, appointments.read/manage, queue.manage |
| hr_manager                             | branches.read, users.read, holidays.read, org_structure.manage, employees.read/manage, attendance.read/manage, leave.read/manage (**no patients**)                                  |
| payroll_manager                        | branches.read, holidays.read, employees.read, attendance.read, leave.read, payroll.read/manage/pay (**no approve, no patients**)                                                    |
| department_manager                     | branches.read, holidays.read (team rights come from being someone's "reports to")                                                                                                   |
| receptionist                           | branches.read, holidays.read, patients.read/manage, appointments.read/manage, queue.manage                                                                                          |
| doctor                                 | branches.read, holidays.read, patients.read, appointments.read, queue.manage (**own queue only**, can't cancel)                                                                     |
| nurse                                  | branches.read, holidays.read, patients.read, appointments.read, queue.manage                                                                                                        |
| employee                               | holidays.read (+ own attendance/leave/payslips/messages via employee link)                                                                                                          |

- **Managers** are simply employees whom others "report to". They get "My team", leave and
  correction approvals, and can message their team.
- Users without `patients.manage` see **masked phone numbers**.
- Payroll **approval** needs `payroll.approve`, which only owner/admin have.

## 8. Key business rules by area

**Onboarding (platform console, `/platform`):**

- The operator signs in, clicks "Onboard a hospital" (name, code, owner name/email, first branch),
  and gets a **one-time owner link** (7 days, only the hash is stored). The owner sets a password at
  `/invite` and is signed in.
- "New sign-in link" revokes older links and doubles as "forgot password" for owners.
- Suspend signs everyone out and blocks login; reactivate restores. Counts only, never records.
- `npm run platform:admin` creates console accounts. `org:create` still exists for scripts and local
  setups.

**Patients:**

- A phone number is a **contact, not an identity**. One contact links to many patients via
  `contact_patient_links` (relationship + `pending/authorized/revoked`).
- Reception registrations are authorized at once. On the website and WhatsApp, the first "self"
  profile is authorized and **family members are pending** until staff authorize them. Pending
  patients can't be booked or managed online.
- **Duplicate check**:
  - names are normalised (case, spaces, punctuation, titles, word order) and compared by bigram
    similarity with a configurable threshold (default 0.85);
  - a match needs the date of birth by default (configurable);
  - a shared phone alone is never a match;
  - reception sees possible matches; a confirmed registration creates a review item;
  - only a person can merge (kept record + `merged` record, nothing deleted).
- **Consent**: append-only records per purpose (`privacy_notice`, `whatsapp_service`,
  `sms_service`, `marketing`) with channel, source, acting contact and notice version. The newest
  record wins. `communicationAllowed()` gates messages. A published privacy notice is required
  before registration, and published notices are locked.
- **Data principal requests** (access/correction/erasure/grievance/nomination) are tracked to an
  outcome.

**Appointments and queue:**

- Doctors have weekly sessions (slot length, patients per slot), days off and a booking window.
- Booking runs in a transaction that **locks the doctor row**; there is one active booking per
  patient/doctor/day; `Idempotency-Key` makes retries safe.
- The **token is issued at booking** from a per-doctor/day counter. Walk-ins get the next token
  (priority 0–2 with a reason).
- Queue flow: booked → waiting (arrived, same day only) → called → in consultation → done; also
  no-show, cancel and requeue. "Call next" picks by priority, then token. "Close day" marks the rest
  as no-show. Doctors can act only on their own queue.
- **Tracking link** (`/track/<code>`): token, now serving, people ahead, and an approximate wait (the
  average of today's consultations, after 3; otherwise the doctor's configured minutes). No names.
- Waiting-room display: tokens only.
- Live screens poll every 5 s (dashboard every 15 s).

**WhatsApp:**

- The hospital number is mapped by Meta **phone number ID** (`whatsapp_channels`).
- The webhook verifies the signature, dedupes by message ID, acknowledges quickly, and processes in
  the background, with a sweep that retries every minute. Text is cleared after handling.
- Menu: 1 book (asks which family member; authorized only), 2 my appointments (+links), 3 cancel,
  4 **my family members** (names + patient numbers only), 5 **register a family member**.
- Unknown numbers can **register in chat**: privacy notice → YES → self/family → name (tidied, e.g.
  "ravi KUMAR" → "Ravi Kumar") → DOB (15-08-1990, 15/8/1990, 1990-08-15) → gender → WhatsApp and
  marketing choices → confirm.
- STOP withdraws WhatsApp consent. No medical details in any message.

**Notifications:**

- After a reception or website booking: WhatsApp template if consented and configured, else SMS if
  consented and configured, else nothing.
- Every attempt is logged in `notification_log`, without message content.

**Employees:**

- Fields: auto IDs `EMP-0001`, mobile (unique per hospital), branch, department, designation, shift,
  week-offs, reporting manager (cycle-checked), employment type and status.
- Exited or suspended employees lose their OTP login.
- **Bulk upload** (`/employees/import`):
  - accepts .xlsx or .csv, up to 1000 rows; headers are matched loosely;
  - every row is checked; the import is all-or-nothing in one transaction;
  - managers can be referenced by employee ID or mobile, including rows in the same file;
  - it can create missing departments and designations.

**Attendance:**

- Geofence: distance ≤ radius **and** GPS accuracy ≤ radius, then an SMS OTP.
- The work date follows the branch timezone; overnight shifts are handled.
- Day status comes from check-in → check-out time versus full-day/half-day minutes, with late grace,
  free lates per month, and late penalty modes (none, fixed_amount, half_day_per_n,
  full_day_per_n). Overtime counts after a threshold.
- Regularization (correction) requests; manual edits need a reason.
- Approved leave is overlaid on attendance. Approved payroll periods lock attendance and leave.

**Leave:**

- Types have a quota, accrual (yearly upfront prorated, or monthly), carry forward, half days,
  notice period, maximum consecutive days, and approval levels (1 = manager, 2 = manager then HR).
- Overlap and balance checks run under a row lock.

**Payroll:**

- The engine works in BigInt paise.
- Components are fixed or a % of another component.
- Day rate is chosen per hospital (calendar, working or fixed days).
- Deductions: LOP from attendance, late penalty, pay policies (fixed, percent, per unit;
  monthly/one-time/instalments), adjustments, statutory lines.
- A calculation snapshot is stored per item and can be re-verified.
- **Approved runs are immutable** (database triggers); corrections go to the next run.
- Separate permissions for prepare (manage), approve and pay.
- Payslip PDF, ZIP and CSV (with a formula-injection guard).
- Approval auto-messages employees "Your payslip for <month> is ready".

**Statutory:**

- EPF, ESI, professional tax, LWF and gratuity are org-entered, approved and effective-dated rules;
  approved rules are immutable.
- Calculated on earned wages after LOP; employer shares are shown but not deducted.
- TDS is a monthly amount set per employee; gratuity is an estimate report.

**Messages:**

- HR: any type, any audience. Payroll: payroll messages only. Managers: their own team only, no
  payroll.
- Inbox with unread badge; senders see read counts.
- Optional SMS alert says only that a message is waiting, never the content.

**Analytics:**

- Workforce (`employees.read` + `attendance.read`): headcount, joiners/exits, attendance totals,
  lateness, overtime, by department, leave by type.
- Clinic (`appointments.read`): bookings, seen, no-show rate, waits, consultations, per day, per
  doctor, by channel, arrivals by hour, new patients.

## 9. Web surfaces and main pages (`apps/web/src`)

**Staff/employee app** (`app/App.jsx`):

| Area                 | Paths                                                                                                                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public pages         | `/login`, `/employee-login`, `/invite`, `/track/:code`, `/queue-display/:doctorId`, `/platform/*`                                                                                                                                                                |
| Signed in            | `/` (dashboard with role shortcuts), `clinic`, `analytics`, `reception`, `patients`, `patients/new`, `patients/:id`, `doctors`, `privacy`, `messaging`                                                                                                           |
| HR and payroll       | `attendance` (+ `register`, `settings`, `requests`, `team`, `employees/:id`), `leave`, `payroll` (+ `runs/:id`, `salaries`, `statutory`, `setup`), `employees` (+ `import`, `new`, `:id`), `holidays`, `company-setup`, `branches`, `users`, `audit`, `messages` |
| Employee's own pages | `my-attendance`, `my-leave`, `my-payslips`, `my-messages`                                                                                                                                                                                                        |

**Patient website** (`patient/PatientApp.jsx`): `/` (sign in, then My hospitals and add by code),
`/clinic/:code` (QR landing; auto-joins; Book, My appointments, Family & privacy tabs),
`/track/:code`.

**Platform console** (`platform/PlatformApp.jsx`, served under `/platform` on the staff site):
sign-in, forced password change, hospital list and onboarding form, hospital detail (usage, owners,
new link, suspend/reactivate, history).

## 10. Configuration (every variable is in `.env.example` with comments)

| Group                              | Variables                                                                                                                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core                               | `APP_ENV`, `APP_SECRET_KEY`, `PORT`/`API_PORT`, `LOG_LEVEL`                                                                                                                                                                                               |
| Database / Redis                   | `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `REDIS_URL`                                                                                                                                                                                                     |
| Site addresses                     | `FRONTEND_URL`. `PATIENT_SITE_URL` is optional; when unset in a deployment it falls back to `FRONTEND_URL` and logs a warning                                                                                                                             |
| Sessions                           | `ACCESS_TOKEN_EXPIRE_MINUTES`, `REFRESH_TOKEN_EXPIRE_DAYS`, `PATIENT_SESSION_DAYS`                                                                                                                                                                        |
| SMS                                | `SMS_PROVIDER` (`console` locally, `msg91` deployed), `MSG91_AUTH_KEY`, `MSG91_OTP_TEMPLATE_ID`, `MSG91_OTP_VARIABLE`, `MSG91_APPOINTMENT_TEMPLATE_ID`, `MSG91_APPOINTMENT_VARIABLES`, `MSG91_MESSAGE_ALERT_TEMPLATE_ID`, `MSG91_MESSAGE_ALERT_VARIABLES` |
| WhatsApp                           | `WHATSAPP_PROVIDER` (`meta`/`console`/empty), `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_GRAPH_API_VERSION`, `WHATSAPP_APPOINTMENT_TEMPLATE`, `WHATSAPP_TEMPLATE_LANGUAGE`                                        |
| Web (public, baked into the build) | `VITE_API_BASE_URL` (`/api/v1`), `VITE_PATIENT_SITE_URL`, `VITE_APP_SURFACE` (`patient` for the patient build)                                                                                                                                            |

Production refuses to start without a real secret, TLS to the database and https site URLs, or when
connected as a superuser or BYPASSRLS database role.

## 11. How to run, test and seed

Local commands (full guide in `README.md`):

| Step                                                     | Command             |
| -------------------------------------------------------- | ------------------- |
| Install and create `.env`                                | `make setup`        |
| Start PostgreSQL and Redis                               | `make up`           |
| Create the tables                                        | `make migrate`      |
| Load a fictional demo hospital (prints logins once)      | `npm run seed:demo` |
| Run API :4000, staff app :5173 and patient website :5174 | `make dev`          |

- In development, SMS and WhatsApp messages (including OTPs) are **printed in the API terminal**.
- Other commands:
  - `npm run org:create --workspace apps/api -- --name … --slug … --owner-email … --owner-name …`
  - `npm run platform:admin --workspace apps/api -- --email … --name …`
- Checks that must pass before committing:
  - `npm run lint && npm run format:check && npm test && npm run build`
  - `npm run test:integration --workspace apps/api` (needs `make up`; it recreates the
    `healthos_test` database)
- Test counts at commit `38efeda`: API unit 94, web 19, API integration 175. Every module has a
  cross-tenant isolation test.

## 12. Deployment state and the next manual steps

- `render.yaml` defines 3 web services and Redis.
- The API runs on the **free plan**, so it sleeps when idle; migrations run in the build
  (`npm ci && npm run db:migrate`).
- Move the API to `starter` with `preDeployCommand` before a clinic depends on it (deployment guide
  explains how).

Pending owner actions after the latest push:

1. Render → `healthos-api` → Shell:
   ```bash
   npm run platform:admin --workspace apps/api -- --email … --name "…"
   ```
2. Render → Blueprints → **Sync**, to create `healthos-patient`.
3. Set `PATIENT_SITE_URL` (API) and `VITE_PATIENT_SITE_URL` (web) to the patient site URL, then
   redeploy web.
4. For real use, set up:
   - MSG91 + DLT templates: OTP (required); appointment confirmation and message alert (optional);
   - Meta WhatsApp (optional): access token, app secret, Graph version, template; webhook URL
     `https://<api>/api/v1/webhooks/whatsapp`; each hospital enters its Phone number ID under
     "WhatsApp & SMS";
   - custom domains, uptime monitor, Neon restore drill.

Operations guide: `docs/operations/runbook.md`. Deployment guide: `docs/deployment/render-neon.md`.

## 13. Not built / open items (say so plainly if asked)

**Not built:**

- Medical history / clinical notes (pilot decision).
- Cross-hospital history sharing (future, consent-based; ADR 0009).
- Overtime approval workflow.
- Employee documents (needs file storage).
- WebSocket push (polling is used).
- Platform UI to create other platform admins (CLI only).
- Staff-user invite links inside a hospital (owners still create users with temporary passwords).
- Performance reviews (only messages).
- Automatic monthly accrual job (accrual is computed at read time).

**Known limits:**

- A mid-month salary revision uses the period-end structure (a warning is shown).
- TDS is a manual monthly amount.
- Patients are visible to all branches of a hospital.
- Times are shown in IST.
- The free Render plan sleeps when idle.

**Needs professionals before real data:**

- A lawyer: DPDP Act, privacy notice text (including on WhatsApp), and **hosting outside India**
  (Singapore).
- A payroll adviser: statutory rules and TDS.
- An external penetration test before scale-up.

## 14. Conventions and gotchas for anyone changing the code

- Follow `AGENTS.md` hard rules: no secrets in git; no hardcoded statutory values; `withTenant` +
  explicit `organization_id` filters; RLS enabled+forced in each new tenant table's migration; zod
  at the route boundary; `AppError(status, CODE, message)`; money as strings or BigInt; audit
  sensitive actions; never log OTPs, passwords, tokens, bank data or identity numbers (add keys to
  `REDACT_PATHS`).
- Every schema change ships with a Knex migration. Migrations already deployed to Neon must never
  be edited; add a new one.
- zod is **v4** (`z.literal(x, { error })`, not `errorMap`).
- Knex row-lock skip is `.forUpdate().skipLocked()`.
- When writing files from scripts, never write a literal BOM character into JS; use `﻿` (ESLint
  `no-irregular-whitespace`).
- In this build environment Docker Hub may rate-limit pulls. Images were pulled from
  `mirror.gcr.io` and compose runs with `--pull never`.
- gitleaks false positives (test fixtures, env var names) are allow-listed in `.gitleaks.toml`.
  Never allow-list a real secret.
- Commit messages end with the Co-Authored-By and Claude-Session lines used throughout the history.
  Do not put model names in commits or code.

## 15. Where to find more

| Topic                     | File                                                      |
| ------------------------- | --------------------------------------------------------- |
| Original requirements     | `docs/healthos-platform-project-spec.json`                |
| Rules for contributors    | `AGENTS.md`                                               |
| Setup and overview        | `README.md`                                               |
| API reference             | `docs/api.md`                                             |
| HR rules                  | `docs/requirements/hr-attendance-leave-payroll.md`        |
| Patients and consent      | `docs/requirements/patients-consent.md`                   |
| Queue                     | `docs/requirements/appointments-queue.md`                 |
| WhatsApp and SMS          | `docs/requirements/whatsapp-sms.md`                       |
| Messages                  | `docs/requirements/employee-messages.md`                  |
| Architecture and security | `docs/architecture/*.md` (including `security-review.md`) |
| Decisions                 | `docs/adr/0001`–`0011`                                    |
| Roadmap                   | `docs/roadmap.md`                                         |
| Deploy                    | `docs/deployment/render-neon.md`                          |
| Operations                | `docs/operations/runbook.md`                              |
