# HealthOS demo: logins and a guided tour

The **demo** runs on Render's free plan from the `demo` branch, with its **own database** and only
**fictional** people. The pilot (branch `main`) never contains this data. How to set the demo up from
zero: [docs/deployment/demo-setup.md](docs/deployment/demo-setup.md).

## Addresses

Render assigns the addresses. Write yours here after the first deploy:

| Website              | Address                                                        |
| -------------------- | -------------------------------------------------------------- |
| Staff & employee app | `https://healthos-demo-web.onrender.com` (check in Render)     |
| Patient website      | `https://healthos-demo-patient.onrender.com` (check in Render) |
| Platform console     | staff app address + `/platform`                                |

The free server **sleeps after about 15 minutes without visitors**. The first page after that can take
about a minute to load; after that it is fast. Open it a few minutes before showing someone.

## Password and hospital code

- **Password for every email login below:** `HealthOS-Demo-2026`
- **Hospital code** (employees and patients type it, or it comes with the QR link): `demo-hospital`
- **SMS codes:** the demo shows the 6-digit code **on the screen** for the demo numbers below. No SMS is
  sent.

This password only opens the demo. Never use it for the pilot or any real hospital.

## Logins (2 of every type)

### Platform console (the HealthOS team): `<staff app>/platform`

| Email                          | What to try                                                              |
| ------------------------------ | ------------------------------------------------------------------------ |
| `platform@demo-hospital.test`  | See all hospitals, onboard a new hospital, get the owner's one-time link |
| `platform2@demo-hospital.test` | Same, as a second team member                                            |

### Hospital staff: `<staff app>/login`

| Role               | Emails                                                                                                                             | What to try                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Owner / admin      | `owner@demo-hospital.test`, `admin@demo-hospital.test`                                                                             | Everything: analytics, payroll approval, users & roles, audit log        |
| Clinic manager     | `clinic@demo-hospital.test`, `clinic2@demo-hospital.test`                                                                          | Clinic today, doctors, patient privacy, analytics                        |
| Receptionist       | `reception@demo-hospital.test`, `reception2@demo-hospital.test`                                                                    | Register a patient, book, add a walk-in, call next, waiting-room display |
| Doctor             | `doctor@demo-hospital.test` (Dr. Kavya), `doctor2@demo-hospital.test` (Dr. Arjun)                                                  | "My queue": call, start, done. Also their own attendance and payslips    |
| Nurse              | `nurse@demo-hospital.test` (Nisha), `nurse2@demo-hospital.test` (Pooja)                                                            | Queue and patient lookup, own attendance                                 |
| HR manager         | `hr@demo-hospital.test`, `hr2@demo-hospital.test`                                                                                  | Employees (and Excel upload), attendance, leave, messages                |
| Payroll manager    | `payroll@demo-hospital.test`, `payroll2@demo-hospital.test`                                                                        | Salaries, last month's approved payroll, payslip PDFs                    |
| Department manager | `manager@demo-hospital.test` (Meena: Imran, Leela, Kiran), `manager2@demo-hospital.test` (Vikram: Ravi, Sara, Divya, Nisha, Pooja) | My team, approve leave and corrections, message the team                 |

### Employees: `<staff app>/employee-login`

Company code `demo-hospital`, then the mobile number. The code appears on screen.

| Mobile     | Name  | Team                 |
| ---------- | ----- | -------------------- |
| 9000000102 | Ravi  | Nursing (Vikram)     |
| 9000000103 | Sara  | Nursing (Vikram)     |
| 9000000108 | Divya | Nursing (Vikram)     |
| 9000000104 | Imran | Front office (Meena) |
| 9000000106 | Leela | Front office (Meena) |
| 9000000107 | Kiran | Front office (Meena) |

**Mark attendance** checks the phone's location against the branch (central Bengaluru, 100 m). To
try it from anywhere, sign in as the owner, open **Branches**, set the branch location to where you
are (or raise the radius), then check in as an employee.

### Patients: `<patient website>`

Sign in with the mobile number (the code appears on screen). When asked, the hospital code is
`demo-hospital`.

| Mobile     | People on that number                                                          |
| ---------- | ------------------------------------------------------------------------------ |
| 9000000201 | Asha, her son Kabir, her mother Lata (Lata is "awaiting the hospital's check") |
| 9000000202 | Rohit and his wife Priya                                                       |
| 9000000203 | Fatima                                                                         |
| 9000000204 | Gopal                                                                          |
| 9000000205 | Neha                                                                           |
| 9000000206 | Arun                                                                           |

### Registering new people during the demo

The demo sends no SMS, so codes appear on screen **only for demo numbers**: 10 digits starting with
`9000000`, for example `9000000300`, `9000000301`. When a receptionist registers a new patient (or HR adds
an employee) for someone to sign in as, use such a number. A real mobile number is saved, but that person
can't sign in on the demo ("This is a demo, so no SMS is sent").

## What's already in the demo

- 12 employees in 3 departments. **Last month:** full attendance with some late arrivals, half days and
  absences, and an **approved payroll** with payslips.
- Leave: Ravi's request was **approved by Vikram**; Sara's is **waiting**.
- Messages from HR to everyone and from Vikram to Ravi; payslip-ready notices.
- 2 doctors with timings, today's bookings and walk-ins, two weeks of past visits for analytics.
- 11 patient records, including two families, one family member waiting for the hospital's check, and
  one possible duplicate ("Aasha Demo") in **Patient privacy → Duplicate review**.

## A 10-minute tour

1. **Patient** (on a phone): open the patient website, sign in with `9000000201`, book Kabir with a
   doctor, then tap **Track live queue**.
2. **Reception** (`reception@…`): open **Reception & queue**, find the booking, add a walk-in, mark an
   arrival, **Call next**. Open the waiting-room display in another tab.
3. **Doctor** (`doctor@…`): **My queue**: start and finish a consultation. The patient's tracking page
   updates.
4. **Employee** (on a phone): employee sign-in with `9000000102`; check in (see the location note
   above).
5. **Manager** (`manager2@…`): **Leave**: approve Sara's request. **Send messages** to the team.
6. **Payroll / owner**: **Payroll**: open last month's approved run and download a payslip PDF.
7. **Owner**: **Analytics** (clinic and workforce) and the **Audit log**.
8. **Platform console** (`platform@…`): onboard a new hospital and see the one-time owner link.

## Starting the demo data again

The demo hospital is created once. To get a fresh copy, change `DEMO_HOSPITAL_CODE` on the demo API in
Render (for example to `demo-hospital-2`) and redeploy. A new demo hospital is created with the same
logins under the new code (for example `owner@demo-hospital-2.test`). The old one stays until you
suspend it in the platform console.
