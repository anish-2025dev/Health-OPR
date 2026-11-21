# Delivery roadmap

Phases come from the project spec. A phase starts only after its plan is approved. Detailed HR scope:
[`requirements/hr-attendance-leave-payroll.md`](requirements/hr-attendance-leave-payroll.md).

| #   | Phase                                 | Key deliverables                                                                                                                                                                                             | Status                                                                                                                       |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 0   | Architecture & repository foundation  | Monorepo, AGENTS.md, README, devcontainer, Docker Compose, ADRs                                                                                                                                              | ✅ Done                                                                                                                      |
| 1   | Application foundation                | React app, Express API, PostgreSQL + Redis connections, health endpoints, CI, Render + Neon deployment                                                                                                       | ✅ Done (minimal); WebSocket and job worker scaffolds deferred to the phases that need them                                  |
| 2   | Tenant authentication & authorization | Organizations, branches, users, roles, permissions, RLS, tenant isolation tests                                                                                                                              | ✅ Done                                                                                                                      |
| 3   | Patient registration                  | Clinic QR landing page, OTP adapter, patient profile, contact links, family selection                                                                                                                        | ✅ Done                                                                                                                      |
| 4   | Consent & privacy                     | Notice versions, consent records, communication preferences, withdrawal, audit                                                                                                                               | ✅ Done                                                                                                                      |
| 5   | Appointments & queue                  | Doctor schedules, appointments, walk-ins, check-in, transactional tokens, live queue                                                                                                                         | ✅ Done (live updates by 5-second polling)                                                                                   |
| 6   | WhatsApp & SMS                        | Webhook, existing-patient lookup, family selection, booking flow, templates, SMS fallback                                                                                                                    | ✅ Done (needs Meta WhatsApp + MSG91 accounts to go live)                                                                    |
| 7   | Clinic dashboard                      | Patient search, appointment management, queue board, receptionist workflow, reports                                                                                                                          | ✅ Done (live updates by 5-second polling)                                                                                   |
| 8   | Employee management                   | Departments, designations, shifts, week-offs, holiday calendar, employee profiles (ID, mobile, branch, reporting manager, status), branch geofence. Documents deferred to a later phase (needs file storage) | ✅ Done                                                                                                                      |
| 9a  | Attendance                            | Attendance policies, employee mobile-OTP sign-in, "Mark attendance" with geofence + SMS OTP, status engine, dashboards, late-in, team view, edit with reason, regularization, exports                        | ✅ Done                                                                                                                      |
| 9b  | Leave                                 | Configurable leave types, balances/accrual, apply/cancel, 1- or 2-level approval, team calendar, LOP                                                                                                         | ✅ Done                                                                                                                      |
| 10  | Payroll foundation                    | Day-rate setting, salary components/structures, company deduction policies, attendance-driven deductions, payroll runs, approval, payslip PDFs, bulk/own download                                            | ✅ Done                                                                                                                      |
| 11  | Statutory payroll                     | Effective-dated rule configuration, PF, ESI, professional tax, TDS, gratuity, professional validation                                                                                                        | ✅ Done (rules entered and approved by each organization; TDS amount set by payroll; professional validation still required) |
| 12  | Employee self-service & analytics     | Employee portal polish, workforce analytics                                                                                                                                                                  | ✅ Done (workforce + clinic analytics, employee messages)                                                                    |
| 13  | Production readiness                  | Security review, load tests, backup restore test, monitoring, deployment hardening, runbooks                                                                                                                 | ✅ Done for pilot (security review, runbook, restore drill, CSP); load test and external pen test before scale-up            |

## Build order (HR and clinic in parallel)

The product owner chose to alternate HR and clinic work after the shared foundation:

```
2 Auth & tenancy (shared)
 → 8  Employees & org structure  (also the staff and doctor records the clinic side needs)
 → 3+4 Patient registration + consent
 → 9a Attendance (QR)
 → 5  Appointments & queue
 → 9b Leave
 → 7  Clinic dashboard
 → 10 Payroll & payslips
 → 6  WhatsApp & SMS
 → 11 Statutory payroll → 12 → 13
```

Each step is deployable on its own. Phase 13 items such as backups, monitoring and a security review must be
in place before real patient or employee data is used. Payroll used for real salaries also needs
professional payroll validation (Phase 11).

---

## Suntek Ecosystem Architecture Restructuring Roadmap

Transforming HealthOS into two independent, loosely coupled, scalable SaaS products and an operator control plane:

| Phase | Title                                          | Scope & Key Deliverables                                                                                                                                                                                                                          | Status  |
| ----- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **0** | **System Audit & SRS Gap Analysis**            | Baseline audit of 131 tests, SRS implementation for missing features (Tasks, Claims, Device restriction, Shift/Profile requests, Owner analytics).                                                                                                | ✅ Done |
| **1** | **Architectural Design & Contracts**           | Specifications for Suntek-Mgt, Suntek-ops, Platform Control Plane, Integration Contracts, and Target Topologies in `docs/architecture/`.                                                                                                          | ✅ Done |
| **2** | **Logical Product Decoupling**                 | Domain router factories (`createMgtRouter`, `createOpsRouter`, `createPlatformDomainRouter`), mounted at `/api/v1/mgt/*`, `/api/v1/ops/*`, and `/api/v1/platform/*` with 100% root backward compatibility.                                        | ✅ Done |
| **3** | **Independent Frontend Surfaces**              | Portal shells (`MgtApp.jsx`, `OpsApp.jsx`), surface switcher in `Root.jsx`, build scripts (`build:mgt`, `build:ops`, `build:patient`, `build:platform`).                                                                                          | ✅ Done |
| **4** | **Database Decoupling & Isolation**            | Foreign key relaxation on `doctors.department_id` (`ON DELETE SET NULL`, migration 17), defensive handling for missing departments, independent schema queries.                                                                                   | ✅ Done |
| **5** | **Error Handling & Observability**             | Domain-scoped error factories (`mgtError`, `opsError`, `platformError`), correlation ID tracking (`X-Correlation-ID`), Pino logging, audit metadata injection.                                                                                    | ✅ Done |
| **6** | **Automated Testing & CI/CD Pipelines**        | Domain test segregation (`test:mgt`, `test:ops`, `test:platform`), parallel GitHub Actions matrix execution for domain tests and multi-surface builds.                                                                                            | ✅ Done |
| **7** | **Security Hardening & Boundary Verification** | Row-Level Security audit across all 17 migrations, cryptographic JWT audience isolation (`healthos`, `healthos-patient`, `healthos-platform`), PII redaction.                                                                                     | ✅ Done |
| **8** | **Production Deployment Blueprint**            | Infrastructure as Code blueprints (`render.yaml`, `render.decoupled.yaml`), runtime `PRODUCT_MODE` scoping, multi-origin CORS, health probe suite (`/healthz`, `/api/v1/health/live`, `/api/v1/health/ready`), zero-downtime & rollback runbooks. | ✅ Done |
| **9** | **Production & Staging Verification**          | End-to-end integration checklist, cross-domain test execution, documentation finalization, and release sign-off.                                                                                                                                  | ✅ Done |

---

## Suntek Ecosystem Architecture Restructuring Roadmap

Transforming HealthOS into two independent, loosely coupled, scalable SaaS products and an operator control plane:

| Phase | Title                                          | Scope & Key Deliverables                                                                                                                                                                                                                          | Status  |
| ----- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **0** | **System Audit & SRS Gap Analysis**            | Baseline audit of 131 tests, SRS implementation for missing features (Tasks, Claims, Device restriction, Shift/Profile requests, Owner analytics).                                                                                                | ✅ Done |
| **1** | **Architectural Design & Contracts**           | Specifications for Suntek-Mgt, Suntek-ops, Platform Control Plane, Integration Contracts, and Target Topologies in `docs/architecture/`.                                                                                                          | ✅ Done |
| **2** | **Logical Product Decoupling**                 | Domain router factories (`createMgtRouter`, `createOpsRouter`, `createPlatformDomainRouter`), mounted at `/api/v1/mgt/*`, `/api/v1/ops/*`, and `/api/v1/platform/*` with 100% root backward compatibility.                                        | ✅ Done |
| **3** | **Independent Frontend Surfaces**              | Portal shells (`MgtApp.jsx`, `OpsApp.jsx`), surface switcher in `Root.jsx`, build scripts (`build:mgt`, `build:ops`, `build:patient`, `build:platform`).                                                                                          | ✅ Done |
| **4** | **Database Decoupling & Isolation**            | Foreign key relaxation on `doctors.department_id` (`ON DELETE SET NULL`, migration 17), defensive handling for missing departments, independent schema queries.                                                                                   | ✅ Done |
| **5** | **Error Handling & Observability**             | Domain-scoped error factories (`mgtError`, `opsError`, `platformError`), correlation ID tracking (`X-Correlation-ID`), Pino logging, audit metadata injection.                                                                                    | ✅ Done |
| **6** | **Automated Testing & CI/CD Pipelines**        | Domain test segregation (`test:mgt`, `test:ops`, `test:platform`), parallel GitHub Actions matrix execution for domain tests and multi-surface builds.                                                                                            | ✅ Done |
| **7** | **Security Hardening & Boundary Verification** | Row-Level Security audit across all 17 migrations, cryptographic JWT audience isolation (`healthos`, `healthos-patient`, `healthos-platform`), PII redaction.                                                                                     | ✅ Done |
| **8** | **Production Deployment Blueprint**            | Infrastructure as Code blueprints (`render.yaml`, `render.decoupled.yaml`), runtime `PRODUCT_MODE` scoping, multi-origin CORS, health probe suite (`/healthz`, `/api/v1/health/live`, `/api/v1/health/ready`), zero-downtime & rollback runbooks. | ✅ Done |
| **9** | **Production & Staging Verification**          | End-to-end integration checklist, cross-domain test execution, documentation finalization, and release sign-off.                                                                                                                                  | ✅ Done |
