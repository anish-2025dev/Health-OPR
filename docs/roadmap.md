# Delivery roadmap

Phases come from the project spec. A phase starts only after its plan is approved. Detailed HR scope:
[`requirements/hr-attendance-leave-payroll.md`](requirements/hr-attendance-leave-payroll.md).

| #   | Phase                                 | Key deliverables                                                                                                                                                  | Status                                                                                      |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 0   | Architecture & repository foundation  | Monorepo, AGENTS.md, README, devcontainer, Docker Compose, ADRs                                                                                                   | ✅ Done                                                                                     |
| 1   | Application foundation                | React app, Express API, PostgreSQL + Redis connections, health endpoints, CI, Render + Neon deployment                                                            | ✅ Done (minimal); WebSocket and job worker scaffolds deferred to the phases that need them |
| 2   | Tenant authentication & authorization | Organizations, branches, users, roles, permissions, RLS, tenant isolation tests                                                                                   | ✅ Done                                                                                     |
| 3   | Patient registration                  | Clinic QR landing page, OTP adapter, patient profile, contact links, family selection                                                                             |                                                                                             |
| 4   | Consent & privacy                     | Notice versions, consent records, communication preferences, withdrawal, audit                                                                                    |                                                                                             |
| 5   | Appointments & queue                  | Doctor schedules, appointments, walk-ins, check-in, transactional tokens, live queue                                                                              |                                                                                             |
| 6   | WhatsApp & SMS                        | Webhook, existing-patient lookup, family selection, booking flow, templates, SMS fallback                                                                         |                                                                                             |
| 7   | Clinic dashboard                      | Patient search, appointment management, queue board, receptionist workflow, reports                                                                               |                                                                                             |
| 8   | Employee management                   | Profiles, departments, designations, reporting managers, documents, shifts, week-offs, holiday calendar                                                           |                                                                                             |
| 9a  | Attendance                            | Attendance policies, rotating QR check-in, status engine, dashboards, late-in, team view, edit with reason, regularization, exports                               |                                                                                             |
| 9b  | Leave                                 | Configurable leave types, balances/accrual, apply/cancel, 1- or 2-level approval, team calendar, LOP                                                              |                                                                                             |
| 10  | Payroll foundation                    | Day-rate setting, salary components/structures, company deduction policies, attendance-driven deductions, payroll runs, approval, payslip PDFs, bulk/own download |                                                                                             |
| 11  | Statutory payroll                     | Effective-dated rule configuration, PF, ESI, professional tax, TDS, gratuity, professional validation                                                             |                                                                                             |
| 12  | Employee self-service & analytics     | Employee portal polish, workforce analytics                                                                                                                       |                                                                                             |
| 13  | Production readiness                  | Security review, load tests, backup restore test, monitoring, deployment hardening, runbooks                                                                      |                                                                                             |

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
