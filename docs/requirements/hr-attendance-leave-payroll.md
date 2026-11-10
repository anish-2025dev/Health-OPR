# HR requirements: attendance, leave, deduction policies and payslips

**Status:** Agreed scope, to be implemented in phases (see `docs/roadmap.md`).
**Source:** Product owner request plus an attendance-management feature walkthrough. We implement these
capabilities in HealthOS's own design; we do not copy another product's UI or branding.

Decisions made by the product owner (2026-11-10):

| Topic                      | Decision                                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build order                | HR and clinic phases **in parallel** (alternating), after Phase 2                                                                                                     |
| Day rate for deductions    | **Admin chooses** per company: calendar days, working days, or a fixed divisor (e.g. 30, 26)                                                                          |
| Leave approval             | **Configurable per leave type**: 1 level (reporting manager) or 2 levels (manager → HR)                                                                               |
| Attendance capture (pilot) | **QR at the clinic** (rotating). Manual admin correction with a mandatory reason and regularization requests are always available (spec requirement). Biometric later |

General rules from the project spec still apply: tenant isolation, backend authorization, audit logs,
transactions, no hardcoded statutory values, immutable finalized payroll, and no real data in development.

---

## 1. Roles

| Role                            | Can do                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization admin / HR manager | Configure policies, leave types, holidays, shifts; manage employees; edit attendance (with reason); approve regularizations; override leave decisions (with reason); export |
| Payroll manager                 | Salary structures, deduction policies, payroll runs, payslips. **Approving** and **marking paid** are separate permissions                                                  |
| Department / reporting manager  | View team attendance; approve team leave and regularization requests (when configured)                                                                                      |
| Employee                        | Check in/out via QR; see own attendance, leave balances and payslips; apply for leave; request regularization                                                               |
| Kiosk (device role)             | Shows the branch's rotating attendance QR only; no data access                                                                                                              |

HR roles get no access to patient data, and clinic roles (receptionist, doctor, nurse) get no access to salary data.

---

## 2. Attendance

### 2.1 Attendance policy (configurable by admin)

A company can have several policies (for example "Default", "Night shift"). Each is assigned to
employees, departments or branches, and each is **versioned with effective dates**, so past months are
always calculated with the policy that applied at the time.

| Setting                    | Example                                | Meaning                                               |
| -------------------------- | -------------------------------------- | ----------------------------------------------------- |
| Full-day hours             | 9 h                                    | Worked hours ≥ this → **Present**                     |
| Half-day hours             | 5 h                                    | Worked hours ≥ this but < full day → **Half Day**     |
| Below half-day             | Absent / Reduced Hours                 | What to mark when worked hours < half-day hours       |
| Late grace                 | 30 min                                 | Check-in within shift start + grace is on time        |
| Late categories            | 30–60 min "Late", > 60 min "Very late" | Labels shown in reports                               |
| Free late arrivals / month | 4                                      | Lates within this count carry no penalty              |
| Late penalty mode          | see below                              | What happens after the free count                     |
| Early check-in window      | 60 min                                 | Earliest a check-in is accepted before shift start    |
| Overtime threshold         | after full day + 30 min                | OT counted only beyond this; **OT requires approval** |
| Minimum punch gap          | 40 s                                   | Ignores accidental double scans                       |
| Week-off pattern           | Sun / alternate Sat                    | Days marked **Week Off**                              |

**Late penalty modes** (admin picks one per policy):

1. **None**: only tracked and reported.
2. **Fixed amount per late** beyond the free count (for example ₹50 per late). The admin enters the amount.
3. **Every N lates = half-day deduction** (for example 3 lates → 0.5 day).
4. **Every N lates = full-day deduction**.

Example values in this document are illustrations only. Every company enters its own values.

### 2.2 Daily status

`Present`, `Absent`, `Half Day`, `Reduced Hours`, `Leave` (paid or unpaid, linked to the approved leave),
`Week Off`, `Holiday`, and `On Duty` (optional). Each day stores: shift, first check-in, last check-out, all
punches, worked hours, break, OT (requested/approved), late minutes, late category, status, and source
(`qr`, `manual`, `regularization`, `import`, and later `biometric`).

The status is computed from punches and the policy, and recomputed when punches, leave or the policy
change, until payroll for that month is finalized. After finalization the day is locked, and later
corrections become payroll **adjustments** in the next run.

### 2.3 QR check-in

- A kiosk device at each branch shows a QR code that **rotates every 30–60 seconds**. Each code is a signed,
  short-lived challenge tied to that branch, so a screenshot stops working almost immediately.
- The employee scans it with their phone while logged in to HealthOS. The server checks the code is
  valid, unexpired, for that branch and not already used, then records the punch for the logged-in employee.
- The first scan of the day is check-in and later scans are check-out (subject to the minimum punch gap).
- Optional later: GPS/Wi-Fi checks, which need a privacy notice and a lawful basis.

### 2.4 Screens

| Screen                       | Who                     | Contents                                                                                                                                                    |
| ---------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attendance dashboard         | Admin/HR                | Today: total employees, checked in, absent, on leave, late. Colour-coded cards with counts                                                                  |
| Department & source insights | Admin/HR                | Department-wise chart with date picker; attendance by source; this month's holidays                                                                         |
| Late in today                | Admin/HR, managers      | Late arrivals with department filter, check-in time, minutes late, late category, reporting manager                                                         |
| Team attendance              | Managers                | Monthly summary of direct reports; filter by department and month; search; open details                                                                     |
| Employee attendance detail   | Admin/HR, manager, self | Day-by-day month view: shift, in/out, hours, OT, break, punches, status; late-policy usage this month (grace used, lates, penalty); monthly summary; export |
| My attendance                | Employee                | Own monthly log and statuses; request regularization from any day                                                                                           |
| All-employee register        | Admin/HR                | Company-wide daily register filtered by date, branch and department; list/grid; search; export                                                              |
| Attendance management + edit | Admin/HR                | Table with status badges; **Edit** opens the day showing the employee's policy; choose a status; **reason is mandatory**; audit-logged                      |
| Regularization requests      | Admin/HR, managers      | Totals (pending/approved/rejected); search; sort by date; filter by status; approve or reject with a comment                                                |
| Exports                      | Admin/HR                | Monthly attendance, holidays for the year, approved leaves and balances. Choose the month, then export CSV / Excel / PDF                                    |

### 2.5 Regularization (attendance correction requests)

An employee picks a day, gives corrected times or a status (for example "forgot to check out"), and adds
a reason. The request goes to the reporting manager (or HR, per configuration). Approving it updates the
day with source `regularization`. Rejecting it needs a comment. Every request and decision is audit-logged.

---

## 3. Leave

### 3.1 Leave types (configurable by admin)

| Setting              | Example                                                  |
| -------------------- | -------------------------------------------------------- |
| Name / code          | Casual Leave / CL                                        |
| Paid or unpaid       | Paid                                                     |
| Annual entitlement   | 12 days                                                  |
| Accrual              | Up front each leave year, or monthly (1/month)           |
| Carry forward        | No / up to N days                                        |
| Half-day allowed     | Yes                                                      |
| Minimum notice       | 1 day (0 for sick leave)                                 |
| Max consecutive days | 3                                                        |
| Attachment required  | After 2 days (for example a medical certificate)         |
| Sandwich rule        | Whether week-offs/holidays inside a leave count as leave |
| **Approval levels**  | **1 (reporting manager) or 2 (manager → HR)**            |
| Eligibility          | After probation / employment types / branches            |

Company-level settings: the **leave year** (calendar year or April–March) and the holiday calendar per branch.

### 3.2 Employee

- **Balance cards per leave type:** entitled, accrued, used, pending, **available**.
- **Apply:** pick the type, from/to dates and half-day options, and give a reason. The app shows working
  days counted (excluding week-offs and holidays unless the sandwich rule applies) and the balance after
  approval. It warns when the balance is insufficient; the excess becomes **loss of pay (LOP)** if the
  company allows that.
- **Scheduled (future) leave** goes to the approver right away. The employee can cancel it while it is
  pending, and can ask to cancel an approved leave that hasn't started.
- History of all requests and decisions.

### 3.3 Manager / HR

- Approval inbox showing the requester's balance, overlapping team leave, and the team calendar.
- Approve or reject. Rejecting needs a comment.
- With 2-level types, a manager approval moves the request to HR.
- HR/Admin can override any decision, with a reason that is audit-logged.
- Approved leave sets the matching attendance days to `Leave` automatically.

---

## 4. Payroll, deduction policies and payslips

### 4.1 Company payroll settings

- **Day rate basis (admin chooses):** calendar days in the month, working days in the month, or a fixed
  divisor (for example 30 or 26). Day rate = monthly gross (or the components the admin selects) ÷ basis.
- Pay period (monthly), cut-off date for attendance, and rounding rules.

### 4.2 Salary components & structures

- Components: earnings (Basic, HRA, allowances…) and deductions. Each is calculated as a **fixed amount**,
  a **% of another component**, or a **formula**.
- Each employee has an effective-dated salary structure, and revisions keep history.
- Statutory components (PF, ESI, professional tax, TDS…) are added in Phase 11 from **admin-entered,
  approved, effective-dated rules**. The software never ships hardcoded statutory rates.

### 4.3 Deduction & earning policies (company-defined)

The admin creates any number of policies:

| Field              | Options                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| Name               | e.g. "Late penalty", "LOP", "Half-day deduction", "Canteen", "Salary advance recovery"                     |
| Type               | Deduction or earning                                                                                       |
| Calculation        | Fixed amount · % of component · **per unit × attendance metric**                                           |
| Attendance metrics | LOP days, absent days, half days, late count (beyond the free count), reduced-hour days, approved OT hours |
| Frequency          | Every month (recurring) · one-time · installments (e.g. an advance over 5 months)                          |
| Applies to         | Everyone / branch / department / designation / specific employees                                          |
| Effective          | From / to dates                                                                                            |

Built-in attendance-driven rules (amounts come from the policy, not code):

- **LOP / absent day:** `days × day rate`.
- **Half day:** `0.5 × day rate`, unless covered by half-day leave.
- **Late penalty:** per the attendance policy's penalty mode (fixed per late, or N lates → 0.5 or 1 day).
- **OT pay (earning):** approved OT hours × the rate the admin defines.

### 4.4 Monthly payroll run

```
Draft → Inputs locked → Calculated → Review → Approved → Finalized → (Payment: pending / paid / failed)
```

1. **Lock inputs:** take a snapshot of each employee's monthly attendance summary (payable days, LOP,
   half days, lates, OT), approved leave, salary structure and active policies.
2. **Calculate:** each line item records its source (for example "Late penalty: 6 lates − 4 free = 2 × ₹50").
3. **Review:** a payroll manager sees totals and differences from last month, flags anomalies, and can
   add **manual adjustments** with a reason.
4. **Approve** (a separate permission), then **Finalize**. The run becomes **immutable**. Later corrections
   are adjustment or reversal entries in a later run.
5. **Payment status** is tracked separately from calculated salary. Bank export comes later.

Calculations must be reproducible: re-running from the stored snapshot gives the same numbers. Money uses
exact decimals.

### 4.5 Payslips

- Generated as PDF from the finalized snapshot: company details, employee and period; attendance summary
  (working days, payable days, LOP, lates); every earning and deduction with its label; gross, total
  deductions and net pay.
- **Admin / payroll:** download one payslip or **bulk download (ZIP)** for a run, and re-download any time.
- **Employee:** download **only their own** payslips, with a salary and deduction breakdown. This is enforced
  on the server and covered by tests.
- Sensitive identifiers (bank account, PAN, UAN) are masked on payslips and screens.

---

## 5. Tests that must exist (in addition to the spec's critical scenarios)

- Late counting: on time within grace; free lates not penalized; each penalty mode calculates correctly.
- Status computation: full/half/reduced/absent boundaries; week-offs and holidays; leave overrides.
- QR: expired, reused, wrong-branch and forged codes are rejected; the minimum punch gap is respected.
- Manual edit without a reason is rejected, and an edit with a reason writes an audit entry.
- Leave: balance math (accrual, carry forward, half days, sandwich rule); LOP when exceeded; 1- and
  2-level approval; a manager cannot approve leave for someone outside their team; an employee cannot
  approve their own leave.
- Payroll: each day-rate basis; LOP/half-day/late deductions; recurring/one-time/installment policies;
  reproducibility from the snapshot; a finalized run cannot be edited; approve and mark-paid permissions
  are separate.
- Payslips: an employee gets 403/404 for another employee's payslip; another tenant can never access them.
