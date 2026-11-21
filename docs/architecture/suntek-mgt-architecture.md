# Suntek-Mgt — Architecture Specification

**Product:** Suntek-Mgt (Human Resource Management System)  
**Status:** Approved Architectural Specification (Phase 1)  
**Date:** 2026-11-21  
**Target Audience:** Engineering, Product, DevOps, Security

---

## 1. System Mission & Scope

Suntek-Mgt is an independent, enterprise-grade Human Resource Management System (HRMS) and Workforce Operations platform designed specifically for healthcare organizations, clinics, and distributed enterprises.

It operates as an independent, fully autonomous SaaS product that requires **zero runtime dependency** on hospital operations, patient management, queue tracking, or clinical systems. When deployed alongside Suntek-ops, it integrates seamlessly via well-defined REST contracts.

---

## 2. Core Functional Modules

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            SUNTEK-MGT CORE DOMAINS                          │
├───────────────────────────────┬─────────────────────────────┬───────────────┤
│    WORKFORCE & STRUCTURE      │    TIME, ATTENDANCE & LEAVE │  COMPENSATION │
├───────────────────────────────┼─────────────────────────────┼───────────────┤
│ • Departments & Designations  │ • Branch Geofencing GPS     │ • Pay Rules   │
│ • Shifts, Week-offs, Holidays │ • SMS OTP Punch In / Out    │ • Components  │
│ • Employee Directory & Master │ • Single-Device Restriction │ • Structures  │
│ • Reporting Hierarchies       │ • Attendance Regularization │ • Statutory   │
│ • Profile Update Requests     │ • 2-Level Leave Approvals   │ • Pay Runs    │
│ • Shift Change & Swap Requests│ • Team Leave Calendar       │ • Payslip PDF │
├───────────────────────────────┼─────────────────────────────┴───────────────┤
│      OPERATIONS & TASKS       │            FINANCE, CLAIMS & MESSAGING      │
├───────────────────────────────┼─────────────────────────────────────────────┤
│ • Task Assignment (TL/Manager)│ • Employee Advances, Loans & Insurance      │
│ • Priority & Overdue Tracking │ • BigInt Paise Calculation & Repayment Logs │
│ • Employee Task Dashboard     │ • Internal Broadcast & Direct Messaging     │
│ • Task Progress & Comments    │ • Workforce & Owner Consolidated Analytics  │
└───────────────────────────────┴─────────────────────────────────────────────┘
```

### 2.1 Workforce Structure & Employee Directory

- **Organizational Hierarchy:** Departments, designations, working shifts, and holiday calendars scoped strictly per organization and branch.
- **Employee Identification:** Unique employee codes (`EMP-0001`), mobile numbers (enforced unique per organization), branch assignments, and reporting manager graphs.
- **Self-Service Requests:**
  - **Shift Change Requests:** Temporary, permanent, and shift-swap workflows with Manager/HR approval.
  - **Profile Update Requests:** Controlled employee profile corrections (address, emergency contact, phone) verified by HR before database commit.

### 2.2 Time, Attendance & Device Security

- **Anti-Buddy Punching & Geofencing:** Mathematical Haversine distance verification ($\text{distance} \le \text{branch radius}$) and accuracy thresholding ($\text{accuracy} \le \text{branch radius}$).
- **SMS OTP Verification:** First punch = IN, second punch = OUT; verification via SMS OTP ensures physical possession of the registered device.
- **Single-Device Restriction:** Hardware device fingerprinting (`device_fingerprint`). Prevents simultaneous logins across multiple devices. Device resets require explicit HR authorized approval (`/hr/employees/:id/reset-device`).
- **Regularization:** Discrepancy correction requests with reason audit and supervisor approval.

### 2.3 Leave Management

- **Configurable Policies:** Annual quotas, accrual models, carry-forward caps, and loss-of-pay (LOP) triggers.
- **2-Level Approval Engine:** Level 1 (Reporting Manager) $\to$ Level 2 (HR).
- **Concurrency Protection:** PostgreSQL row-level locks on leave balance records prevent race conditions during concurrent applications.

### 2.4 Task Allocation & Workload Tracking

- **Role-Based Task Management:** Team Leaders and Managers assign tasks with priority (`low`, `medium`, `high`, `critical`) and deadlines.
- **Employee Interaction:** Personal task dashboard (`/me/tasks`), status transitions (`pending`, `in_progress`, `on_hold`, `completed`), and progress comments.
- **Overdue & Workload Analytics:** Manager workload monitoring to identify bottlenecks and overdue deliverables.

### 2.5 Employee Claims, Advances & Loans

- **Financial Requests:** Categories include Insurance claims, Salary Advances, Employee Loans, and Other business expenses.
- **Exact Monetary Precision:** All financial values stored and computed as `BIGINT` in paise (1 INR = 100 paise) to prevent floating-point rounding errors.
- **Repayment Tracking:** Structured monthly deduction schedules integrated into subsequent payroll runs.

### 2.6 Payroll & Statutory Compliance

- **Salary Architecture:** Gross CTC, customizable earnings components (Basic, HRA, Conveyance, Allowances), and deduction policies (LOP, late penalties).
- **Effective-Dated Statutory Rules:** Organization-configured EPF, ESI, Professional Tax, Labor Welfare Fund, and Gratuity slabs. Never hardcoded; approved by organizational compliance advisers.
- **Immutable Pay Runs:** Finalized payroll protected by PostgreSQL database triggers preventing post-approval alteration. Corrective actions handled strictly via reversal or adjustment records.
- **Secure Payslips:** PDF generation with formula-injection sanitization (`=`, `+`, `-`, `@` guards for CSV exports) and bulk ZIP archive distribution.

---

## 3. Database Ownership & Schema Architecture

All Suntek-Mgt tables are owned and managed by the Mgt domain. Every tenant table contains `organization_id` with PostgreSQL Row-Level Security (RLS) **enabled and forced**.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SUNTEK-MGT DATABASE TABLES                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ Organization Structure:                                                     │
│   • departments                                                             │
│   • designations                                                            │
│   • shifts                                                                  │
│   • holidays                                                                │
│                                                                             │
│ Employee Master & Security:                                                 │
│   • employees                                                               │
│   • employee_device_registrations                                           │
│   • profile_update_requests                                                 │
│   • shift_change_requests                                                   │
│                                                                             │
│ Time & Attendance:                                                          │
│   • attendance_policies                                                     │
│   • attendance_punches                                                      │
│   • attendance_days                                                         │
│   • attendance_regularizations                                              │
│                                                                             │
│ Leave Management:                                                           │
│   • leave_types                                                             │
│   • leave_requests                                                          │
│   • leave_balance_adjustments                                               │
│                                                                             │
│ Operations & Tasks:                                                         │
│   • tasks                                                                   │
│   • task_comments                                                           │
│                                                                             │
│ Financial Claims & Loans:                                                   │
│   • employee_claims                                                         │
│                                                                             │
│ Payroll & Statutory:                                                        │
│   • payroll_settings                                                        │
│   • salary_components                                                       │
│   • salary_structures                                                       │
│   • pay_policies                                                            │
│   • payroll_runs                                                            │
│   • payroll_items                                                           │
│   • payroll_adjustments                                                     │
│   • statutory_rules                                                         │
│   • employee_statutory                                                      │
│                                                                             │
│ Communication & Audit:                                                      │
│   • employee_messages                                                       │
│   • audit_logs (Mgt-scoped events)                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Identity & Authentication Boundaries

Suntek-Mgt uses two primary authentication entry points:

1. **Administrative & Managerial Access (`healthos` Audience):**
   - Credentials (email/password) authenticated against `users` and `auth_sessions`.
   - Access token (15-min JWT, audience: `healthos`) + Rotating Refresh Token (`hos_refresh` HTTP-only cookie).
   - Roles: `organization_owner`, `hr_admin`, `payroll_admin`, `department_manager`, `team_leader`.
2. **Employee Mobile Self-Service Access:**
   - Company Code + Mobile Number $\to$ SMS OTP verification.
   - Enforces single-device fingerprint check (`employee_device_registrations`). If an unapproved device connects, returns `DEVICE_RESTRICTED` (HTTP 403).
   - Grants personal scoped access to `/me/*` routes (attendance, tasks, leave, claims, profile, messages).

---

## 5. Security & Isolation Controls

1. **Dual-Layer Tenancy:** Every query enforces explicit `organization_id = req.auth.organizationId` SQL filtering combined with execution inside `withTenant(db, req.auth.organizationId, ...)`.
2. **No Clinical Bleed:** Suntek-Mgt contains **no references** to patients, medical records, clinic appointments, doctor schedules, or queues.
3. **Statutory Integrity:** Statutory rates are effective-dated and immutable once assigned to a finalized pay run.
