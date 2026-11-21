# Suntek Ecosystem — Migration Plan & Production Risk Analysis

**Document:** Restructuring Migration Plan & Risk Assessment  
**Status:** Approved Architectural Specification (Phase 1)  
**Date:** 2026-11-21  
**Target Sequence:** Phases 2 through 9

---

## 1. Migration Overview

The transformation of the monolithic HealthOS codebase into Suntek-Mgt and Suntek-ops follows a strict, non-destructive, phased migration sequence.

At every phase:

- Existing production APIs remain fully functional.
- Existing database tables and records are never dropped or altered destructively.
- PostgreSQL Row-Level Security (RLS) is maintained and forced on all tenant tables.
- All 131 automated unit, integration, and security tests continue to pass.

---

## 2. Phase-by-Phase Execution Plan

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MIGRATION EXECUTION PHASES                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   Phase 1: Architectural Design & Integration Contracts        [ COMPLETED ]│
│   Phase 2: Logical Product Decoupling & Independent Routers    [ NEXT ]     │
│   Phase 3: Independent Frontend Surfaces & Build Targets                    │
│   Phase 4: Database Decoupling & Foreign Key Relaxation                     │
│   Phase 5: Standardized Error Handling & Structured Observability           │
│   Phase 6: Automated Testing Pipelines & CI/CD Split                        │
│   Phase 7: Security Hardening & Vulnerability Verification                  │
│   Phase 8: Production Deployment Blueprint Preparation                      │
│   Phase 9: Production Validation & Staging Verification                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Detailed Phase Milestones:

- **Phase 2: Logical Product Decoupling & Independent Routers**
  - Create `apps/api/src/modules/mgt.routes.js`: router mounting exclusively HRMS modules (`/departments`, `/designations`, `/shifts`, `/holidays`, `/hr/employees`, `/attendance`, `/leave`, `/payroll`, `/messages`, `/tasks`, `/hr/claims`, `/shift-requests`, `/profile-requests`, `/analytics/workforce`, `/analytics/owner`).
  - Create `apps/api/src/modules/ops.routes.js`: router mounting exclusively Hospital Ops modules (`/patients`, `/privacy`, `/doctors`, `/appointments`, `/queue`, `/integrations`, `/webhooks/whatsapp`, `/analytics/clinic`, `/public/track`, `/patient-auth`, `/patient`, `/public/clinics`).
  - Create `apps/api/src/modules/platform.routes.js`: router mounting Platform Console modules (`/platform/*`).
  - Update `apps/api/src/api/v1/index.js` to assemble them cleanly while preserving all backward-compatible routes.

- **Phase 3: Independent Frontend Surfaces & Build Targets**
  - Create dedicated portal shells in `apps/web/src/`:
    - `MgtApp.jsx`: Suntek-Mgt portal (Navigation containing only HRMS pages: Dashboard, Employees, Attendance, Leave, Shift Changes, Tasks, Claims, Payroll, Messages, Company Setup, Workforce/Owner Analytics).
    - `OpsApp.jsx`: Suntek-ops portal (Navigation containing only Clinic pages: Reception & Queue, Appointments, Doctors, Patients, Patient Privacy, WhatsApp & SMS, Clinic Analytics).
  - Update `Root.jsx` to select shells via `VITE_APP_SURFACE` (`mgt`, `ops`, `patient`, `platform`, `staff`).
  - Add build scripts in `package.json`: `build:mgt`, `build:ops`, `build:patient`, `build:platform`.

- **Phase 4: Database Decoupling & Foreign Key Relaxation**
  - Create migration to safely relax foreign key from `doctors.department_id` to `departments.id` (nullable, `ON DELETE SET NULL`) allowing standalone Ops operation without Mgt.
  - Separate repository query modules cleanly by domain.

- **Phase 5: Centralized Error Handling & Structured Observability**
  - Standardize `AppError` response envelope with product tags (`suntek-mgt` vs `suntek-ops`).
  - Configure domain-tagged Pino loggers with correlation IDs and sensitive data redaction.

- **Phase 6: Automated Testing & CI/CD Pipelines**
  - Add product-specific test commands (`npm run test:mgt`, `npm run test:ops`).
  - Update GitHub Actions workflow.

- **Phase 7: Security Hardening & Vulnerability Verification**
  - Run `npm audit`, verify zero secrets in git, verify RLS bypass protection across all routes.

- **Phase 8: Production Deployment Blueprint Preparation**
  - Update `render.yaml` with independent deployment descriptors while preserving legacy service URLs and existing pilot/demo branches.

- **Phase 9: Production Validation & Staging Verification**
  - Execute end-to-end builds, migration dry runs, and final regression tests.

---

## 3. Production Risk Assessment & Mitigation Matrix

| #   | Risk Description                                   | Severity | Probability | Mitigation Strategy                                                                                                                                                                                      |
| --- | -------------------------------------------------- | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Breaking Existing API Clients**                  | High     | Low         | Retain legacy `/api/v1/*` routes in aggregate root. Add new `/api/v1/mgt/*` and `/api/v1/ops/*` domain routes in parallel.                                                                               |
| 2   | **Tenant Isolation & RLS Bypass**                  | Critical | Very Low    | Keep forced PostgreSQL RLS policy on all tenant tables: `app.rls_bypass='on' OR organization_id = app.current_organization_id::uuid`. All queries run inside `withTenant`. Cross-tenant tests run in CI. |
| 3   | **Accidental Mutation of Finalized Payroll**       | High     | Very Low    | Database-level immutability triggers prevent updates/deletions on approved `payroll_runs`. Corrections handled strictly via adjustment records.                                                          |
| 4   | **Foreign Key Conflict (`doctors.department_id`)** | Medium   | Medium      | In Phase 4 migration, alter foreign key to nullable with `ON DELETE SET NULL`. Handle missing department gracefully in code.                                                                             |
| 5   | **Simultaneous Mobile Device Logins**              | Medium   | Low         | Enforce hardware fingerprinting in `employee_device_registrations`. Returns HTTP 403 `DEVICE_RESTRICTED` on mismatch. Authorized HR reset endpoint available.                                            |
| 6   | **Demo vs. Pilot Environment Contamination**       | High     | Very Low    | Distinct Git branches (`main` for pilot, `demo` for sandbox). Distinct Neon database instances and distinct secret configurations.                                                                       |

---

## 4. Rollback Strategy

1. **Code Rollback:** Since all domain router modules are additive and mounted through `apps/api/src/api/v1/index.js`, rolling back to any previous commit requires zero database downgrades.
2. **Database Migrations:** All new migrations (14-16) include complete, verified `down()` rollback functions.
3. **Deployment Rollback:** In Render, rollback to the previous deployment artifact can be triggered instantly with one click if any anomaly is observed in production logs.
