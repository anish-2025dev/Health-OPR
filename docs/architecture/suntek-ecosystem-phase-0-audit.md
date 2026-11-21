# Suntek Ecosystem — Phase 0: Master System Audit & Restructuring Blueprint

**Status:** Completed  
**Date:** 2026-11-21  
**Project:** Existing HealthOS Platform Transition to Suntek Ecosystem  
**Target Products:**

1. **Suntek-Mgt** — Independent Human Resource Management System (HRMS)
2. **Suntek-ops** — Independent Hospital Management and Operations System
3. **Platform Console** — Operator Control Plane

---

## 1. Executive Summary & Existing System Baseline

### 1.1 Architecture & Stack Baseline

The existing HealthOS codebase is structured as a **modular monolith** within an npm workspaces monorepo:

- **Backend:** Node.js 22, Express 5, JavaScript ESM, Zod v4 validation at route boundaries, Knex query builder, PostgreSQL 17 (hosted on Neon), ioredis rate-limiting (fails open with database lockout fallback), Argon2 password hashing, jose JWT token signing, Pino structured logging, PDFKit for payslips.
- **Frontend:** React 19, Vite 8, Tailwind CSS 4, TanStack Query, React Router 8. Built as a single monorepo package (`apps/web`) code-split by `VITE_APP_SURFACE`:
  - `VITE_APP_SURFACE=staff` (default) serves the staff/employee portal and `/platform` operator console.
  - `VITE_APP_SURFACE=patient` serves the standalone public patient portal (`PatientApp`).
- **Database Architecture:** Multi-tenant shared PostgreSQL schema where every tenant table has an `organization_id` foreign key with **enabled and forced Row-Level Security (RLS)**. Handlers enforce dual-layer isolation: SQL-level filtering combined with `withTenant(db, orgId, fn)` RLS context.
- **Authentication Model:** 4 strictly isolated, non-interchangeable authentication audiences:
  1. `healthos`: Hospital staff & employees (`hos_refresh` cookie, 15-minute access token, rotating refresh token with reuse detection).
  2. `healthos-patient`: Patient portal accounts (`hos_patient_refresh` cookie, 30 days).
  3. `healthos-platform`: Operator console accounts (`hos_platform_refresh` cookie, 7 days).
  4. Public tracking link: Unguessable 16-character tracking codes displaying live queue positions and wait estimates (no names or medical data).

### 1.2 Deployment Baseline

- **Hosting:** Render (Singapore region) with Neon PostgreSQL 17 (AWS `ap-southeast-1`, Singapore).
- **Services on Render Blueprint (`render.yaml`):**
  - `healthos-api`: Node Express web service.
  - `healthos-web`: Static web app for staff and employees.
  - `healthos-patient`: Static web app for the patient website.
  - `healthos-redis`: Render Key Value instance for rate limiting.
- **Branch Strategy:**
  - `main`: Pilot deployment (Render Starter plan, real SMS via MSG91, Meta WhatsApp Cloud API).
  - `demo`: Free demo deployment (`healthos-demo-*` on Render free plan, separate Neon database, demo sign-in codes shown on-screen for fictional `+91 90000 00xxx` numbers).

---

## 2. Feature Inventory

### 2.1 Suntek-Mgt (HRMS Functional Scope)

1. **Organization Structure:** Departments, Designations, Shifts (start/end times, break minutes, overnight handling), Holidays.
2. **Employee Records:** Auto-generated employee numbers (`EMP-0001`), mobile numbers (unique per organization), branch assignment, reporting hierarchy, employment status (`active`, `on_notice`, `suspended`, `exited`), bulk import via Excel/CSV with loose header matching.
3. **Attendance Management:**
   - Geofence verification (phone GPS distance $\le$ branch radius and accuracy $\le$ radius).
   - SMS OTP verification for punch-in / punch-out (first mark = in, second = out).
   - Daily & monthly registers, working hours, late penalty calculations, overtime thresholding.
   - Attendance regularizations (correction requests with manager/HR review).
   - **Device Registration & Restriction (§3.2):** Single registered device per employee with fingerprinting, simultaneous login blocking (`DEVICE_RESTRICTED`), and authorized HR reset.
4. **Leave Management:**
   - Organization-configurable leave types (paid/unpaid, annual quotas, accrual models, carry-forward caps).
   - 2-level configurable approval workflow (Level 1: Reporting Manager; Level 2: HR).
   - Balance tracking under row locks, leave calendar, CSV export.
5. **Shift Management:**
   - Shift schedules, week-offs.
   - **Shift Change Requests (§8.2):** Temporary, permanent, and shift swap requests with approval workflow.
6. **Task Management (§4):**
   - Task assignment by Team Leaders and Managers.
   - Priority levels (`low`, `medium`, `high`, `critical`), deadlines, status tracking (`pending`, `in_progress`, `on_hold`, `completed`, `cancelled`).
   - Employee personal task dashboard (`/me/tasks`), completion notes, progress comments.
   - Manager workload monitoring and overdue tracking.
7. **Employee Claims & Financial Requests (§9):**
   - Request categories: Insurance, Salary Advance, Employee Loans, Other.
   - Repayment duration (months), proposed schedules, supporting documents.
   - HR approval workflow with recorded comments and decider identities.
   - BigInt paise monetary precision, repayment tracking, and outstanding loan calculations.
8. **Payroll & Statutory Management:**
   - Configurable salary structures, earnings components (basic, HRA, conveyance, allowances, incentives) and deductions (LOP from attendance, late penalties, statutory).
   - Effective-dated statutory rules (EPF, ESI, Professional Tax, LWF, Gratuity) configured and approved by organizational advisers (never hardcoded).
   - Automated payslip generation (PDF with formula-injection guard, ZIP archive, CSV export).
   - Immutable approved pay runs protected by database triggers.
9. **Internal Communication:**
   - In-app employee messaging with unread badges, categories (`payroll`, `performance`, `leave`, `attendance`, `general`).
   - Broadcast capabilities: individual, team, department, or organization-wide.
   - Optional SMS alert notifying that a message is waiting.
10. **Profile Update Requests (§7.2):**
    - Employee requests for modifications to personal data, mobile, email, or emergency contact.
    - HR review, approval, and automated profile updates with audit logs.
11. **Workforce Analytics & Owner Dashboard:**
    - Headcount trends, joiners, exits, attendance breakdown, department distribution, loan and payroll summaries.

### 2.2 Suntek-ops (Hospital Management & Operations Scope)

1. **Hospital Administration & Branches:** Multi-branch clinic profiles, operational timings, geofencing setup.
2. **Patient Directory & Relationships:**
   - Phone number treated as contact channel, not patient identity (`contacts` $\to$ `contact_patient_links` $\to$ `patients`).
   - Family member profiles linked to primary account (self profiles authorized; family profiles require staff verification).
   - Inactive/reactivation lifecycle (cancels active tokens/bookings without deleting data).
3. **Patient Privacy & Consent Management:**
   - Published, locked privacy notice versions.
   - Granular consent tracking (`privacy_notice`, `whatsapp_service`, `sms_service`, `marketing`).
   - Data principal requests (access, correction, erasure, grievances).
4. **Duplicate Detection & Merging:**
   - Bigram name similarity calculation with configurable threshold (default 0.85) + DOB matching.
   - Staff review queue for suspected duplicates; manual non-destructive merge moving tokens and open visits.
5. **Doctor Management & Scheduling:**
   - Doctor profiles, consultation durations, booking windows.
   - Weekly schedules (start/end times, slot lengths, patients per slot).
   - Doctor time-off management.
6. **Appointment Booking & Token Allocation:**
   - Transactional booking locking doctor row; prevents double booking.
   - Idempotency key protection for retries and webhook requests.
   - Immediate token issuance from per-doctor/day transactional counter.
   - Walk-in desk registration with priority levels (0–2).
7. **Queue Management:**
   - Lifecycle: booked $\to$ waiting (arrived, same day) $\to$ called $\to$ in consultation $\to$ completed / no-show / cancelled.
   - "Call next" prioritized by urgency level, then token sequence.
   - Role boundaries: Doctors can access and act only on their own assigned queue.
8. **Patient Tracking & Waiting-Room Display:**
   - Public tracking link (`/track/:code`): displays token number, serving token, queue position, estimated wait time; strictly conceals patient names and diagnoses.
   - Waiting-room display (`/queue-display/:doctorId`): tokens and status only.
9. **Patient Website (`PatientApp`):**
   - Independent patient portal: phone + OTP login, join clinic by code, book appointment, manage family profiles, view tracking links.
10. **WhatsApp & SMS Clinic Integrations:**
    - Meta Cloud API webhook with signature validation and asynchronous background processing.
    - WhatsApp conversational bot: booking, family registration, cancel, appointment overview.
    - Consent-aware SMS notifications via MSG91.
11. **Clinic Operational Analytics:**
    - Booking volumes, seen rate, no-show rate, average wait time, average consultation time, doctor breakdown, hourly arrival patterns.

### 2.3 Platform Console (Operator Control Plane)

1. **Operator Authentication:** Dedicated table (`platform_admins`) and session management (`platform_sessions`).
2. **Hospital Onboarding:** Onboards organization, slug, initial branch, and primary owner.
3. **Owner Invitations:** Issues secure, single-use, 7-day tokenized invite links (`user_invites`) for owner password setup.
4. **Lifecycle Control:** Suspends and reactivates tenant organizations.
5. **Operator Audit Logs:** Append-only platform audit logging (`platform_audit_logs`).

---

## 3. Feature Gap & Traceability Matrix

| Requirement                                              | Domain   | Module          | Status     | Verification Detail                                                                                                    |
| -------------------------------------------------------- | -------- | --------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| Role-based Dashboards (Owner, HR, Manager, TL, Employee) | Mgt      | `staff-access`  | `VERIFIED` | Configured in `permissions.js`; Team Leader role created with task/shift rights.                                       |
| Attendance GPS Geofence + SMS OTP                        | Mgt      | `hr-attendance` | `VERIFIED` | Geofence math verified; SMS OTP verified; tested in `attendance-calc.test.js`.                                         |
| Single-Device Restriction & Reset                        | Mgt      | `device`        | `VERIFIED` | Table `employee_device_registrations`; OTP blocks non-matching device; tested in `security-and-vulnerability.test.js`. |
| Task Assignment & Monitoring                             | Mgt      | `tasks`         | `VERIFIED` | Table `tasks` & `task_comments`; CRUD, filters, overdue math verified in `task-calc.test.js`.                          |
| Financial Claims (Insurance, Advances, Loans)            | Mgt      | `hr-claims`     | `VERIFIED` | Table `employee_claims`; BigInt paise math & repayments verified in `claims-calc.test.js`.                             |
| Configurable Leave & 2-Level Approvals                   | Mgt      | `hr-leave`      | `VERIFIED` | Accrual, carry-forward, lock check verified in `leave-calc.test.js`.                                                   |
| Shift Change & Swap Requests                             | Mgt      | `org-structure` | `VERIFIED` | Table `shift_change_requests`; verified in integration test.                                                           |
| Profile Update Requests                                  | Mgt      | `hr-employees`  | `VERIFIED` | Table `profile_update_requests`; verified in integration test.                                                         |
| Flexible Payroll & Statutory Rules                       | Mgt      | `hr-payroll`    | `VERIFIED` | Immutability triggers, paise math verified in `payroll-engine.test.js`.                                                |
| Owner Consolidated Analytics                             | Mgt      | `analytics`     | `VERIFIED` | Endpoint `/analytics/owner` aggregates headcount, attendance, tasks, leaves, claims, payroll.                          |
| Patient Registration & Family Links                      | Ops      | `patients`      | `VERIFIED` | Verified in `patient-matching.test.js` & `patients.test.js`.                                                           |
| Patient Consent & Notice Locking                         | Ops      | `patients`      | `VERIFIED` | `privacy_notice_versions` & `consents` append-only verified.                                                           |
| Doctor Scheduling & Time Off                             | Ops      | `clinic`        | `VERIFIED` | Weekly schedules, day-of-week slots, time-off blocking verified.                                                       |
| Appointment Booking & Row Locking                        | Ops      | `clinic`        | `VERIFIED` | Doctor row lock + daily counter prevents duplicate tokens; verified in `clinic-calc.test.js`.                          |
| Queue Management & Tracking Links                        | Ops      | `clinic`        | `VERIFIED` | Queue states, privacy-preserving tracking links verified.                                                              |
| WhatsApp Bot & Patient Registration                      | Ops      | `whatsapp`      | `VERIFIED` | Webhook verification, state machine verified in `whatsapp-registration.test.js`.                                       |
| Hospital Onboarding & Owner Invites                      | Platform | `platform`      | `VERIFIED` | Dedicated console `/platform`, one-time invite token hashing verified.                                                 |

---

## 4. Architecture Dependency & Decoupling Map

### 4.1 Database Ownership Division

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       SHARED FOUNDATION & TENANCY                           │
│  organizations  •  branches  •  users  •  user_role_assignments             │
│  auth_sessions  •  audit_logs                                               │
└──────────────────────┬───────────────────────────────┬──────────────────────┘
                       │                               │
                       ▼                               ▼
┌──────────────────────────────────────┐  ┌───────────────────────────────────┐
│       SUNTEK-MGT (HRMS DOMAIN)       │  │  SUNTEK-OPS (HOSPITAL DOMAIN)     │
│                                      │  │                                   │
│  departments, designations           │  │  patient_settings, privacy_notices│
│  shifts, holidays                    │  │  contacts, patients               │
│  employees                           │  │  contact_patient_links, consents  │
│  employee_device_registrations       │  │  patient_duplicate_flags          │
│  attendance_policies                 │  │  data_principal_requests          │
│  attendance_punches, attendance_days │  │  doctors, doctor_schedules        │
│  attendance_regularizations          │  │  doctor_time_off                  │
│  leave_types, leave_requests         │  │  appointments                     │
│  leave_balance_adjustments           │  │  queue_counters, queue_entries    │
│  tasks, task_comments                │  │  patient_accounts, patient_otps   │
│  employee_claims                     │  │  patient_account_sessions         │
│  shift_change_requests               │  │  whatsapp_channels                │
│  profile_update_requests             │  │  whatsapp_inbound_events          │
│  payroll_settings, salary_components │  │  whatsapp_conversations           │
│  salary_structures, pay_policies     │  │  notification_log                 │
│  payroll_runs, payroll_items         │  │                                   │
│  payroll_adjustments                 │  │                                   │
│  statutory_rules, employee_statutory │  │                                   │
│  employee_messages                   │  │                                   │
└──────────────────────────────────────┘  └───────────────────────────────────┘
```

### 4.2 Cross-Domain Dependency Analysis & Decoupling Solution

1. **`doctors.department_id -> departments.id`**:
   - _Current State:_ Foreign key constraint links the `doctors` table (Hospital Ops) to `departments` (HRMS).
   - _Decoupling Solution:_ In Suntek-ops standalone mode, department references can be resolved via an internal clinical department lookup or an optional integration adapter. The foreign key constraint will be relaxed to allow standalone operation when Suntek-Mgt is not enabled.
2. **User Identity Linking (`employees.user_id` & `doctors.user_id`)**:
   - Both products link to the shared `users` foundation table.
   - For standalone operation, each product can operate its own authentication provider or consume shared SSO identity when both products are enabled for a tenant.
3. **Direct Database Queries:**
   - Currently, several analytics queries in `apps/api/src/modules/analytics/index.js` join across attendance, queue entries, and employee tables.
   - _Decoupling Solution:_ Separate analytics into dedicated endpoints: `/analytics/workforce` (Suntek-Mgt) and `/analytics/clinic` (Suntek-ops), with `/analytics/owner` querying product data independently.

---

## 5. Deployment Audit

### 5.1 Existing Services (Render Blueprint)

- **`healthos-api`**: Monolithic Express API serving all endpoints on port 4000.
- **`healthos-web`**: Single Vite React static site serving staff/employee dashboard, clinic operations, and `/platform`.
- **`healthos-patient`**: Separate static build serving `PatientApp` (`VITE_APP_SURFACE=patient`).
- **`healthos-redis`**: Key-value store for API rate limiting.

### 5.2 Target Deployment Topology

To achieve complete independent operation and scaling:

```
[ Suntek-Mgt Ecosystem ]
  ├── Suntek-Mgt Frontend   (Vite / React static site: HR, Employees, Attendance, Payroll)
  └── Suntek-Mgt Backend    (Node 22 / Express service: /api/v1/mgt/*)

[ Suntek-ops Ecosystem ]
  ├── Suntek-ops Admin Web  (Vite / React static site: Reception, Doctors, Patients, Queue)
  ├── Suntek-ops Patient Web(Vite / React static site: Public Patient Booking Portal)
  └── Suntek-ops Backend    (Node 22 / Express service: /api/v1/ops/*)

[ Operator Plane ]
  └── Platform Console Web  (Vite / React static site: Hospital Onboarding & Operator Audit)
```

---

## 6. Test Baseline Verification

Executing the automated test suites establishes the verified test baseline:

- **API Unit & Security Tests:** **14 test suites, 112 tests passed (100% passing)**:
  - `claims-calc.test.js`: 1 test passed
  - `task-calc.test.js`: 3 tests passed
  - `security-and-vulnerability.test.js`: 14 tests passed (RBAC, Single-Device Restriction, Money Safety, Formula Injection, IDOR)
  - `attendance-calc.test.js`: 18 tests passed
  - `payroll-engine.test.js`: 12 tests passed
  - `statutory-calc.test.js`: 9 tests passed
  - `leave-calc.test.js`: 8 tests passed
  - `clinic-calc.test.js`: 5 tests passed
  - `patient-matching.test.js`: 6 tests passed
  - `whatsapp-adapter.test.js`: 4 tests passed
  - `whatsapp-registration.test.js`: 2 tests passed
  - `phone.test.js`: 12 tests passed
  - `config.test.js`: 11 tests passed
  - `app.test.js`: 7 tests passed
- **Web Frontend Tests:** **5 test suites, 19 tests passed (100% passing)**:
  - `csv.test.js`: 3 tests passed
  - `Leave.test.jsx`: 1 test passed
  - `Attendance.test.jsx`: 4 tests passed
  - `Employees.test.jsx`: 3 tests passed
  - `App.test.jsx`: 8 tests passed
- **Total Passing Automated Tests:** **131 tests passing**.
- **Lint Status:** `eslint .` passed with **0 errors and 0 warnings**.
- **Frontend Production Build:** `vite build` completed in **627 ms** without errors.

---

## 7. Phased Implementation Roadmap (Phases 1–9)

Following this Phase 0 Audit, the restructuring proceeds in the following controlled, reversible phases:

1. **Phase 1: Architectural Design & Integration Contracts**
   - Define formal boundary interfaces for Suntek-Mgt, Suntek-ops, and Platform Console.
   - Establish service-to-service REST integration contract specifications.
2. **Phase 2: Logical Product Decoupling & Independent Routers**
   - Create domain router entry points:
     - `createMgtRouter()`: mounts only HRMS modules (`/departments`, `/designations`, `/shifts`, `/holidays`, `/hr/employees`, `/attendance`, `/leave`, `/payroll`, `/messages`, `/tasks`, `/hr/claims`, `/shift-requests`, `/hr/profile-requests`, `/analytics/workforce`).
     - `createOpsRouter()`: mounts only Hospital Ops modules (`/patients`, `/privacy`, `/doctors`, `/appointments`, `/queue`, `/integrations`, `/webhooks/whatsapp`, `/analytics/clinic`, `/public/track`, `/patient-auth`, `/patient`, `/public/clinics`).
     - `createPlatformRouter()`: mounts `/platform` onboarding and operator controls.
   - Retain backward-compatible `/api/v1` aggregate root during transition.
3. **Phase 3: Independent Frontend Surfaces & Build Targets**
   - Introduce clean frontend surface targets in Vite configuration:
     - `VITE_APP_SURFACE=mgt` $\to$ Suntek-Mgt HRMS portal.
     - `VITE_APP_SURFACE=ops` $\to$ Suntek-ops Hospital Ops portal.
     - `VITE_APP_SURFACE=patient` $\to$ Suntek-ops Patient website.
     - `VITE_APP_SURFACE=platform` $\to$ Operator Console.
4. **Phase 4: Database Decoupling & Isolation Strategy**
   - Implement repository-level database access separation.
   - Ensure foreign keys across domain boundaries (such as `doctors.department_id`) are safely handled for standalone operation.
5. **Phase 5: Centralized Error Handling & Structured Observability**
   - Standardize `AppError` response envelope with product tags (`suntek-mgt` vs `suntek-ops`).
   - Configure domain-tagged Pino loggers with correlation IDs and sensitive data redaction.
6. **Phase 6: Automated Testing & CI/CD Pipelines**
   - Add product-specific test targets (`test:mgt`, `test:ops`).
   - Configure GitHub Actions to test and build products independently.
7. **Phase 7: Security Hardening & Performance Optimization**
   - Run dependency audit (`npm audit`), Semgrep/Gitleaks secret checks, and verify cross-tenant boundaries.
8. **Phase 8: Production Deployment Blueprint Preparation**
   - Update `render.yaml` with independent deployment descriptors while preserving legacy service URLs and existing pilot/demo branches.
