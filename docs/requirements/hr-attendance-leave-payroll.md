# HR requirements: attendance, leave, deduction policies and payslips

**Status:** Agreed scope, to be implemented in phases (see `docs/roadmap.md`).
**Source:** Product owner request plus an attendance-management feature walkthrough. We implement these
capabilities in HealthOS's own design; we do not copy another product's UI or branding.

Decisions made by the product owner (2026-11-10):

| Topic                           | Decision                                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Build order                     | HR and clinic phases **in parallel** (alternating), after Phase 2                                                                                                                                                              |
| Day rate for deductions         | **Admin chooses** per company: calendar days, working days, or a fixed divisor (e.g. 30, 26)                                                                                                                                   |
| Leave approval                  | **Configurable per leave type**: 1 level (reporting manager) or 2 levels (manager → HR)                                                                                                                                        |
| Attendance capture (pilot)      | **App/website "Mark attendance" → geofence check (default 10 m) → SMS OTP.** Marked only if both pass (see 2.3). Manual admin correction with a mandatory reason and regularization requests always available. Biometric later |
| Staff login (admin/HR/managers) | **Email + password** (Argon2id). MFA added later                                                                                                                                                                               |
| Employee login (self-service)   | **Mobile number + OTP**, then stays signed in. Used to mark attendance and to view own attendance, leave and payslips                                                                                                          |
| Employee self-view              | Employees see their own OT, leaves and balances, late entries, half days and company holidays (see 2.6)                                                                                                                        |

General rules from the project spec still apply: tenant isolation, backend authorization, audit logs,
transactions, no hardcoded statutory values, immutable finalized payroll, and no real data in development.

---

## 1. Roles

| Role                            | Can do                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization admin / HR manager | Configure policies, leave types, holidays, shifts; manage employees; edit attendance (with reason); approve regularizations; override leave decisions (with reason); export |
| Payroll manager                 | Salary structures, deduction policies, payroll runs, payslips. **Approving** and **marking paid** are separate permissions                                                  |
| Department / reporting manager  | View team attendance; approve team leave and regularization requests (when configured)                                                                                      |
| Employee                        | Mark attendance in the app (location + OTP); see own attendance, leave balances and payslips; apply for leave; request regularization                                       |

HR roles get no access to patient data, and clinic roles (receptionist, doctor, nurse) get no access to salary data.

---

## 2. Attendance

### 2.1 Attendance policy (configurable by admin)

A company can have several policies (for example "Default", "Night shift"). Each is assigned to
employees, departments or branches, and each is **versioned with effective dates**, so past months are
always calculated with the policy that applied at the time.

| Setting                    | Example                                | Meaning                                                                                   |
| -------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| Full-day hours             | 9 h                                    | Hours from check-in to check-out ≥ this → **Present** (the shift break is not subtracted) |
| Half-day hours             | 5 h                                    | Worked hours ≥ this but < full day → **Half Day**                                         |
| Below half-day             | Absent / Reduced Hours                 | What to mark when worked hours < half-day hours                                           |
| Late grace                 | 30 min                                 | Check-in within shift start + grace is on time                                            |
| Late categories            | 30–60 min "Late", > 60 min "Very late" | Labels shown in reports                                                                   |
| Free late arrivals / month | 4                                      | Lates within this count carry no penalty                                                  |
| Late penalty mode          | see below                              | What happens after the free count                                                         |
| Early check-in window      | 60 min                                 | Earliest a check-in is accepted before shift start                                        |
| Overtime threshold         | after full day + 30 min                | OT counted only beyond this; **OT requires approval**                                     |
| Minimum punch gap          | 40 s                                   | Ignores accidental double scans                                                           |
| Week-off pattern           | Sun / alternate Sat                    | Days marked **Week Off**                                                                  |

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

### 2.3 Marking attendance (pilot flow, decided 2026-11-10; QR dropped)

**Flow:** employee opens the HealthOS app/website on their phone → taps **Mark attendance** → the app
reads the phone's location → the server verifies it is inside the employee's branch geofence → an SMS
OTP is sent to the employee's registered mobile → the employee enters the OTP → attendance is marked.
**Attendance is marked only if both the location check and the OTP pass.**

1. The employee signs in to HealthOS once on their phone with their **mobile number + OTP** and stays
   signed in (same session model as staff). No QR code or kiosk is needed.
2. They tap **Mark attendance**. The browser asks for the phone's location (HTTPS, high-accuracy mode).
3. The server checks the location against the geofence of the employee's branch, which is set by the
   admin on the Branches page. **If the location fails, no OTP is sent** and the screen explains why
   (outside the area, location off, or too imprecise).
4. If the location passes, a **6-digit OTP** is sent by SMS to the employee's mobile on file, and the
   server remembers this location-verified attempt for 5 minutes.
5. The employee enters the OTP. The server checks it is correct, unexpired, single-use, and belongs to
   the same verified attempt and employee. It then re-checks that the employee is active.
6. **Both pass:** the punch is recorded (first punch of the day = check-in, later = check-out,
   respecting the minimum punch gap), and the screen confirms the time. **Anything fails:** nothing is
   marked, and the failed attempt is logged with its reason.

**Geofence settings (per branch, admin-configurable):**

| Setting                    | Default  | Notes                                                                                                                                                     |
| -------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch location (lat/long) | —        | Admin sets it on a map or by "use my current location" while standing at the clinic                                                                       |
| Radius                     | 10 m     | Product owner's choice. Phone GPS indoors is often 15–50 m, so test with several phones before go-live and raise to 30–50 m if genuine staff are rejected |
| Maximum accepted accuracy  | = radius | If the phone reports accuracy worse than this, the attempt is rejected as "too imprecise" with guidance (turn on precise location, move near a window)    |

A punch passes when `distance_to_branch ≤ radius` and `reported_accuracy ≤ max_accuracy`.

**Safeguards:**

- OTP: 6 digits, 5-minute expiry, single use, at most 5 wrong attempts per OTP; rate limits per
  employee and per IP; a cooldown between OTP requests. OTPs are stored hashed and never logged.
- Location data minimization: each punch stores only the distance from the branch, the reported accuracy
  and the pass/fail result, not a location history. Employees get a notice that location is checked only
  at the moment they mark attendance (DPDP; legal review).
- Every attempt (success or failure) records employee, branch, time, OTP result, geofence result and
  source `app_otp_geo` for the audit trail.
- **Can't check in?** (GPS indoors, phone problem): the employee raises a regularization request (2.5)
  or HR marks attendance manually with a mandatory reason. Both are audit-logged.

**Known limits (accepted for the pilot):** GPS can be spoofed by a determined user, and an employee could
hand their unlocked phone to a colleague who is at the clinic. Geofence + OTP stops the common cases:
marking from home, and colleagues marking for each other without the employee's phone. Later options:
registered-device binding, a rotating QR on a screen at reception, check-in photo, biometric terminals.

**SMS dependency:** OTPs go through the SMS adapter (MSG91 or similar) and need DLT template registration
in India. In development and tests a console adapter is used. Each check-in and check-out sends one SMS.

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

### 2.6 Employee self-view ("My attendance")

Each employee sees **only their own** data. This is enforced on the server.

| Section          | Shows                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| Month summary    | Present, absent, **half days**, reduced-hour days, leave days, week-offs, holidays, payable days                 |
| **Overtime**     | OT per day and month total, with status (requested / approved / rejected)                                        |
| **Late entries** | Each late day with check-in time and minutes late; free lates used vs allowed this month; penalty applied so far |
| **Half days**    | Each half day and why (worked hours below full day, or half-day leave)                                           |
| **Leaves**       | Balance per leave type (available / used / pending), upcoming approved leaves, request history                   |
| **Holidays**     | The company's holiday calendar for the employee's branch (this month and the full year)                          |
| Daily log        | Shift, check-in/out, hours, break, punches, status. Any day can be opened to request a correction                |

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
- Check-in: no OTP is sent when the location fails; wrong, expired, reused or other-employee OTPs are rejected; outside the radius or too-imprecise location is rejected; nothing is marked unless both checks pass; rate limits apply; the minimum punch gap is respected; an employee can only mark their own attendance.
- Manual edit without a reason is rejected, and an edit with a reason writes an audit entry.
- Leave: balance math (accrual, carry forward, half days, sandwich rule); LOP when exceeded; 1- and
  2-level approval; a manager cannot approve leave for someone outside their team; an employee cannot
  approve their own leave.
- Payroll: each day-rate basis; LOP/half-day/late deductions; recurring/one-time/installment policies;
  reproducibility from the snapshot; a finalized run cannot be edited; approve and mark-paid permissions
  are separate.
- Payslips: an employee gets 403/404 for another employee's payslip; another tenant can never access them.
