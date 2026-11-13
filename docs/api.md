# API reference

Base path: `/api/v1`. JSON only. Signed-in staff and employee requests send
`Authorization: Bearer <accessToken>`. Patient-website requests send a patient access token (a separate
token type that staff APIs reject, and the other way round).

Errors always use one envelope with a machine-readable code:

```json
{ "error": { "code": "ROUTE_NOT_FOUND", "message": "No route for GET /x", "requestId": "…" } }
```

Each response carries an `x-request-id` header for tracing. Booking endpoints accept an optional
`Idempotency-Key` header (8–100 letters, digits, `-` or `_`). Repeating a request with the same key
returns the original result instead of booking twice.

## Platform, staff, HR and attendance

| Endpoint                                                                            | Auth / permission                                 | Purpose                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /health`                                                                       | public                                            | Liveness: `{"status":"ok"}`                                                |
| `GET /health/ready`                                                                 | public                                            | Readiness: checks PostgreSQL and Redis; `200` or `503`                     |
| `POST /auth/login`                                                                  | public, rate-limited                              | Email + password → access token + refresh cookie                           |
| `POST /auth/refresh`                                                                | refresh cookie + `X-Requested-With: healthos-web` | Rotate refresh token, new access token                                     |
| `POST /auth/logout`                                                                 | refresh cookie + header                           | End the session                                                            |
| `GET /auth/me`                                                                      | signed in                                         | User, organization, roles, permissions, branch scope                       |
| `POST /auth/change-password`                                                        | signed in                                         | Change own password; signs out other sessions                              |
| `GET /organizations/current`                                                        | signed in                                         | Current organization                                                       |
| `PATCH /organizations/current`                                                      | `organization.manage`                             | Update name, legal name, timezone                                          |
| `GET /branches`                                                                     | `branches.read`                                   | Branches (limited to the user's branch scope)                              |
| `POST /branches`, `PATCH /branches/:id`                                             | `branches.manage`                                 | Create / update / deactivate a branch                                      |
| `GET /users`, `GET /users/roles`                                                    | `users.read`                                      | Staff users with roles; role catalog                                       |
| `POST /users`                                                                       | `users.manage`                                    | Create a user; returns a one-time temporary password                       |
| `PATCH /users/:id`                                                                  | `users.manage`                                    | Update name/phone, enable/disable (ends sessions)                          |
| `PUT /users/:id/roles`                                                              | `users.manage`                                    | Replace role assignments                                                   |
| `POST /users/:id/reset-password`                                                    | `users.manage`                                    | New temporary password; ends sessions                                      |
| `GET /audit-logs?limit&before&action`                                               | `audit.read`                                      | Audit entries, newest first                                                |
| `GET /departments`, `/designations`, `/shifts`                                      | `employees.read` or `org_structure.manage`        | Lookup lists                                                               |
| `POST`/`PATCH` `/departments`, `/designations`, `/shifts`                           | `org_structure.manage`                            | Create, rename, deactivate                                                 |
| `GET /holidays?year&branchId`                                                       | `holidays.read`                                   | Holiday calendar (branch filter includes organization-wide holidays)       |
| `POST /holidays`, `DELETE /holidays/:id`                                            | `org_structure.manage`                            | Manage holidays                                                            |
| `GET /hr/employees?q&branchId&departmentId&status&limit&offset`                     | `employees.read`                                  | Employees (branch-scoped; mobile masked without `employees.manage`)        |
| `GET /hr/employees/:id`                                                             | `employees.read`                                  | One employee                                                               |
| `POST /hr/employees`, `PATCH /hr/employees/:id`                                     | `employees.manage`                                | Create (auto `EMP-0001` IDs) / update, including exit                      |
| `PATCH /branches/:id` with `location`, `geofenceRadiusM`                            | `branches.manage`                                 | Branch attendance location and radius                                      |
| `POST /auth/employee/request-otp` `{company, mobile}`                               | public, rate-limited                              | Sends a sign-in OTP if the number is registered (same response either way) |
| `POST /auth/employee/verify-otp` `{company, mobile, code}`                          | public, rate-limited                              | Employee sign-in → access token + refresh cookie                           |
| `GET /me/attendance/today`                                                          | employee                                          | Today's status and next action (check in / check out)                      |
| `POST /me/attendance/start` `{latitude, longitude, accuracy}`                       | employee                                          | Geofence check; sends an attendance OTP only if inside                     |
| `POST /me/attendance/confirm` `{challengeId, code}`                                 | employee                                          | Verifies the OTP and records the punch                                     |
| `GET /me/attendance?month=YYYY-MM`                                                  | employee                                          | Own month: days, summary, late entries, late penalty, holidays             |
| `GET`/`POST /me/attendance/regularizations`, `POST …/:id/cancel`                    | employee                                          | Own correction requests                                                    |
| `GET`/`PUT /attendance/policy`                                                      | `attendance.read` / `attendance.manage`           | Attendance rules (hours, grace, late penalty, OT)                          |
| `GET /attendance/dashboard?date`                                                    | `attendance.read`                                 | Totals, by department, late arrivals, holidays                             |
| `GET /attendance/register?date&branchId&departmentId`                               | `attendance.read`                                 | Daily register                                                             |
| `GET /attendance/employees/:id/month?month`                                         | `attendance.read`, the employee, or their manager | Month view                                                                 |
| `PUT /attendance/employees/:id/days/:date` `{status?, checkIn?, checkOut?, reason}` | `attendance.manage`                               | Manual correction (reason required, audited)                               |
| `GET /attendance/regularizations?status`, `POST …/:id/approve`, `POST …/:id/reject` | `attendance.manage` or reporting manager          | Decide correction requests                                                 |
| `GET /attendance/team?month`                                                        | reporting managers                                | Direct reports' monthly summary                                            |
| `GET /attendance/export?month&branchId`, `GET /attendance/holidays/export?year`     | `attendance.read` / `holidays.read`               | CSV exports                                                                |

## Bulk employee upload

`POST /hr/employees/import` (`employees.manage`). Body: `{ rows: [{ column: value }], dryRun: true|false,
createMissing: true|false }`. Up to 1000 rows. Columns: Employee ID, Full Name*, Mobile*, Email,
Branch* (code or name), Department, Designation, Shift, Reports To (employee ID or mobile, may be in the
same file), Joining Date* (DD-MM-YYYY), Employment Type, Weekly Off, Emergency Contact Name and Phone.
Headers are matched ignoring case, spaces and underscores. `dryRun` returns per-row errors and saves
nothing. An import with any error returns 400 and saves nothing. A clean import adds every row in one
transaction, and sets managers after all rows are added.

## Platform console

Separate login for the operator's team (see [ADR 0011](adr/0011-platform-console-and-invites.md)):

| Area                         | Endpoints                                                                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in                      | `POST /platform/auth/login` · `POST /platform/auth/refresh` · `POST /platform/auth/logout`                                                                                    |
| Account                      | `GET /platform/me` · `POST /platform/me/password`                                                                                                                             |
| Hospitals                    | `GET/POST /platform/organizations` · `GET /platform/organizations/:id` · `POST /platform/organizations/:id/invites` · `POST /platform/organizations/:id/{suspend,reactivate}` |
| Audit                        | `GET /platform/audit`                                                                                                                                                         |
| Invite links (hospital side) | `GET /auth/invite/:token` · `POST /auth/invite/accept`                                                                                                                        |

## Leave, payroll and statutory

See [`docs/requirements/hr-attendance-leave-payroll.md`](requirements/hr-attendance-leave-payroll.md)
for the rules. Endpoint groups:

| Group         | Endpoints                                                                                                                                                                                                                                                                                                                                                                                          | Permission                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Own leave     | `GET /me/leave/balances` · `GET/POST /me/leave/requests` · `POST /me/leave/preview` · `POST /me/leave/requests/:id/cancel`                                                                                                                                                                                                                                                                         | employee                                                                                        |
| Leave admin   | `GET/POST /leave/types` · `PATCH /leave/types/:id` · `GET/PUT /leave/settings` · `GET /leave/requests` · `POST /leave/requests/:id/{approve,reject,cancel}` · `GET /leave/balances` · `POST /leave/adjustments` · `POST /leave/carry-forward` · `GET /leave/calendar` · `GET /leave/export`                                                                                                        | `leave.read` / `leave.manage`, or reporting manager for approvals                               |
| Own payslips  | `GET /me/payslips` · `GET /me/payslips/:itemId/pdf`                                                                                                                                                                                                                                                                                                                                                | employee                                                                                        |
| Payroll setup | `GET/PUT /payroll/settings` · `GET/POST /payroll/components` · `PATCH /payroll/components/:id` · `GET/POST /payroll/structures` · `GET /payroll/structures/:employeeId/history` · `GET/POST /payroll/policies` · `PATCH /payroll/policies/:id`                                                                                                                                                     | `payroll.read` / `payroll.manage`                                                               |
| Payroll runs  | `GET/POST /payroll/runs` · `GET/DELETE /payroll/runs/:id` · `POST /payroll/runs/:id/calculate` · `POST/DELETE /payroll/runs/:id/adjustments` · `POST /payroll/runs/:id/approve` · `POST /payroll/runs/:id/payments` · `GET /payroll/runs/:id/items/:itemId/verify` · `GET /payroll/runs/:id/items/:itemId/payslip.pdf` · `GET /payroll/runs/:id/payslips.zip` · `GET /payroll/runs/:id/export.csv` | `payroll.read` / `payroll.manage`; approve needs `payroll.approve`; payments need `payroll.pay` |
| Statutory     | `GET/POST /payroll/statutory/rules` · `POST /payroll/statutory/rules/:id/{approve,end}` · `DELETE /payroll/statutory/rules/:id` · `PUT /payroll/statutory/employees/:id` · `GET /payroll/statutory/runs/:id.csv` · `GET /payroll/statutory/gratuity`                                                                                                                                               | `payroll.*` (approve needs `payroll.approve`)                                                   |

## Patients, privacy and the patient website

See [`docs/requirements/patients-consent.md`](requirements/patients-consent.md).

## Doctors, appointments and queue

See [`docs/requirements/appointments-queue.md`](requirements/appointments-queue.md).

## WhatsApp and SMS

See [`docs/requirements/whatsapp-sms.md`](requirements/whatsapp-sms.md).

## Messages to employees

See [`docs/requirements/employee-messages.md`](requirements/employee-messages.md).

## Analytics

| Endpoint                                 | Permission                           | Returns                                                                                                                          |
| ---------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /analytics/workforce?month=YYYY-MM` | `employees.read` + `attendance.read` | Headcount, joiners/exits, attendance totals, late arrivals, overtime, by department, leave by type                               |
| `GET /analytics/clinic?from=&to=`        | `appointments.read`                  | Bookings, seen, no-show rate, average wait/consultation, per day, per doctor, by booking channel, arrivals by hour, new patients |
