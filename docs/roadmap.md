# Delivery roadmap

From the project spec. A phase starts only after its plan is approved.

| #   | Phase                                 | Key deliverables                                                                          | Status                                                                                      |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 0   | Architecture & repository foundation  | Monorepo, AGENTS.md, README, devcontainer, Docker Compose, ADRs                           | ✅ Done                                                                                     |
| 1   | Application foundation                | React app, Express API, PostgreSQL + Redis connections, health endpoints, CI              | ✅ Done (minimal); WebSocket and job worker scaffolds deferred to the phases that need them |
| 2   | Tenant authentication & authorization | Organizations, branches, users, roles, permissions, RLS, tenant isolation tests           | Next                                                                                        |
| 3   | Patient registration                  | Clinic QR landing page, OTP adapter, patient profile, contact links, family selection     |                                                                                             |
| 4   | Consent & privacy                     | Notice versions, consent records, communication preferences, withdrawal, audit            |                                                                                             |
| 5   | Appointments & queue                  | Doctor schedules, appointments, walk-ins, check-in, transactional tokens, live queue      |                                                                                             |
| 6   | WhatsApp & SMS                        | Webhook, existing-patient lookup, family selection, booking flow, templates, SMS fallback |                                                                                             |
| 7   | Clinic dashboard                      | Patient search, appointment management, queue board, receptionist workflow, reports       |                                                                                             |
| 8   | Employee management                   | Profiles, departments, designations, documents, permissions                               |                                                                                             |
| 9   | Attendance, shifts & leave            | Attendance, QR check-in, manual correction, rosters, leave approval                       |                                                                                             |
| 10  | Payroll foundation                    | Salary structures, periods, earnings/deductions, approvals, payslips                      |                                                                                             |
| 11  | Statutory payroll                     | Effective-dated rules, PF, ESI, PT, TDS, gratuity, professional validation                |                                                                                             |
| 12  | Employee self-service & analytics     | Employee portal, own payslips, leave requests, workforce analytics                        |                                                                                             |
| 13  | Production readiness                  | Security review, load tests, backup restore test, monitoring, deployment, runbooks        |                                                                                             |

## Pilot fast path (suggestion)

For a front-desk clinic pilot, the minimum useful slice is **Phases 2 → 3 → 4 → 5 → 7**: tenants and
logins, patient registration, consent, appointments and queue, and the receptionist dashboard. WhatsApp
(6) and the HR/payroll phases (8–12) can follow once the pilot is live. Phase 13 items such as backups,
HTTPS and monitoring must be in place before any real patient data enters the pilot.
