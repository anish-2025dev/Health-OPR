# HealthOS: Healthcare Operations OS

HealthOS is software for hospitals, clinics and nursing homes in India. One installation serves many
hospitals ("organizations"). Each hospital's data is completely separate from every other hospital's.

It has three parts:

| Part                     | Who uses it                                                                                   | Address when running locally |
| ------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------- |
| **Staff & employee app** | Hospital owners, admins, reception, doctors, nurses, HR, payroll, managers and every employee | http://localhost:5173        |
| **Patient website**      | Patients and their families                                                                   | http://localhost:5174        |
| **API**                  | Both websites, plus WhatsApp webhooks                                                         | http://localhost:4000/api/v1 |

> **Pilot build. Use made-up (synthetic) data only.** Read [Before real data](#before-real-patient-or-employee-data)
> before entering any real patient or employee information.

---

## What it does

**For the clinic**

- **Patient registration** at the reception, or by the patient on the patient website (QR code at the
  desk). One phone number can be shared by a whole family; each person is a separate patient record.
- **Duplicate check:** staff are warned if someone may already be registered. Records are never merged
  automatically; a person reviews them.
- **Privacy:** versioned privacy notices, separate consent for WhatsApp, SMS and marketing (each can be
  withdrawn), and data requests (access, correction, erasure, grievance).
- **Doctors and appointments:** weekly hours, days off, slots, online booking window.
- **Live queue:** a token number for every booking and walk-in, arrival check-in, "call next" by
  priority, a waiting-room TV display, and a **live tracking link** for the patient ("now serving 12,
  3 ahead of you, about 25 min"). Patients can leave home at the right time.
- **WhatsApp** (optional): patients register (privacy notice first), book, check and cancel on
  WhatsApp, see which family members are registered, and choose who a booking is for. Confirmations
  go by WhatsApp or SMS, following each patient's consent.
- **Clinic dashboard and analytics:** visits, no-shows, waiting times, busiest hours, per doctor.

**For HR and staff**

- **Employees:** departments, designations, shifts, week-offs, holidays and reporting managers;
  add one by one or upload many from Excel/CSV, with a row-by-row check before anything is saved.
- **Attendance:** the employee taps **Mark attendance** on their phone. The phone's location must be
  inside the branch radius (default 10 m, set per branch) **and** the employee must enter the SMS code.
  The first mark of the day is the in time and the second is the out time. Late, half-day and overtime
  are worked out automatically. Includes corrections, a register and exports.
- **Leave:** leave types, balances, accrual, carry-forward, apply/cancel, and approval in one or two
  levels (manager, then HR).
- **Payroll:** salary components and structures, company deduction policies, a day rate chosen by the
  admin, loss of pay from attendance, late penalties, approval (after which payroll can't change), and
  payslip PDFs (single or ZIP).
- **Statutory rules (PF, ESI, PT, LWF, gratuity):** entered and approved by the organization with dates
  of validity. **No statutory rates are built in.**
- **Messages:** HR, payroll and managers send payroll, performance, leave or general messages to
  employees, with an unread badge in the employee's app. Employees are told automatically when payslips
  are ready.

**Platform console** (for your own team at `/platform`): onboard hospitals, send owners a one-time
sign-in link, see usage counts, suspend or reactivate a hospital.

**Each person sees only their own part:** owners and admins see everything. HR sees employees,
attendance and leave. Payroll sees salaries. Reception sees patients and the queue. Doctors see their
own queue. HR and payroll roles have no access to patients, and clinic roles have no access to salaries.

---

## Run it on your computer (about 10 minutes)

### What you need

- **Node.js 22** or newer. Check with `node -v`.
- **Docker Desktop** (or Docker Engine with Compose). It runs PostgreSQL and Redis for you.
- **Git**

On Windows, use WSL2 (Ubuntu) and run everything inside it.

### Steps

1. **Get the code**

   ```bash
   git clone https://github.com/anish-2025dev/Health-OPR.git
   ```

   ```bash
   cd Health-OPR
   ```

2. **Install packages and create your `.env` file** (copied from `.env.example`; it only contains safe
   local defaults)

   ```bash
   make setup
   ```

   No `make`? Run `npm ci` and copy `.env.example` to `.env` yourself.

3. **Start PostgreSQL and Redis** (in Docker)

   ```bash
   make up
   ```

4. **Create the database tables**

   ```bash
   make migrate
   ```

5. **Load a demo hospital** with fictional patients, doctors, employees and two weeks of history

   ```bash
   npm run seed:demo
   ```

   It prints the demo logins and a password. **Copy them now**, because the password is shown only once.

6. **Start everything** (API, staff app and patient website)

   ```bash
   make dev
   ```

   Keep this terminal open. **SMS codes (OTPs) are printed in this terminal** in development, so
   no SMS account is needed.

7. **Open the apps**

   | Try this                     | Where                                          | How                                                                                                                                         |
   | ---------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
   | Platform console (your team) | http://localhost:5173/platform                 | `platform@demo-clinic.test` and the printed password                                                                                        |
   | Staff                        | http://localhost:5173/login                    | `owner@`, `admin@`, `clinic@`, `reception@`, `doctor@`, `nurse@`, `hr@`, `payroll@` or `manager@demo-clinic.test`, and the printed password |
   | Employee                     | http://localhost:5173/employee-login           | Company code `demo-clinic`, mobile `9000000102` (Ravi); the OTP is shown in the API terminal                                                |
   | Patient                      | http://localhost:5174                          | Mobile `9000000201`, OTP from the terminal, hospital code `demo-clinic`                                                                     |
   | Live queue link              | Reception → book → **Copy live tracking link** | Open it on any device                                                                                                                       |

**Testing "Mark attendance":** the browser asks for your location, and you must be within the branch
radius. The demo branch is in central Bengaluru with a 100 m radius. To try it from where you are,
sign in as the owner, open **Branches**, set the branch location to your current position, and
raise the radius if you're indoors (GPS indoors is often 20–50 m off).

### Onboarding hospitals (platform console)

Your own team manages client hospitals at http://localhost:5173/platform. Create your first platform
admin once:

```bash
npm run platform:admin --workspace apps/api -- --email you@yourcompany.com --name "Your Name"
```

Sign in with the printed password and set your own. **Onboard a hospital** creates it and gives you a
one-time link to send to the hospital owner; they set their password and are signed in. See
[ADR 0011](docs/adr/0011-platform-console-and-invites.md).

### Starting your own (empty) hospital from the command line

```bash
npm run org:create --workspace apps/api -- --name "My Clinic" --slug my-clinic --owner-email owner@my-clinic.example --owner-name "Owner Name"
```

It prints a temporary password. The owner signs in, sets a new password, then sets things up in this
order:

1. **Branches:** address, and the location and radius used for attendance.
2. **Users & roles:** add staff logins.
3. **Company setup:** departments, designations and shifts.
4. **Employees.**
5. **Doctors:** add doctors and their hours.
6. **Patient privacy → Privacy notices:** write and publish a notice. Patients can't be registered
   until one is published.
7. **Patient privacy → Clinic QR page:** print the QR code for the reception desk.

### Using GitHub Codespaces instead

Choose **Code → Codespaces → Create codespace on main** (a 4-core machine is best). Setup runs by itself.
Then run steps 4–6 above and open the forwarded ports **5173** and **5174**.

---

## Everyday commands

| Command                                         | What it does                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `make up` / `make down`                         | Start / stop PostgreSQL and Redis (your data is kept)                               |
| `make dev`                                      | Run the API (:4000), staff app (:5173) and patient website (:5174) with auto-reload |
| `make migrate` / `make rollback`                | Apply / undo database migrations                                                    |
| `npm run seed:demo`                             | Create a demo hospital with fictional data (`-- --slug other` for another one)      |
| `npm run org:create --workspace apps/api -- …`  | Create a real organization and its owner login                                      |
| `make test`                                     | Unit tests (no database needed)                                                     |
| `npm run test:integration --workspace apps/api` | API tests against a real PostgreSQL test database (`make up` first)                 |
| `make lint`                                     | ESLint and Prettier checks                                                          |
| `npm run build`                                 | Production builds of both websites (`apps/web/dist` and `apps/web/dist-patient`)    |
| `docker compose down -v`                        | **Deletes** the local database and starts fresh (then `make up`, `make migrate`)    |

Before committing, everything below must pass (CI runs the same):

```bash
npm run lint && npm run format:check && npm test && npm run build
```

```bash
npm run test:integration --workspace apps/api
```

---

## How the code is organized

```
apps/
  api/                     Express API (Node 22, JavaScript, ES modules)
    src/
      api/v1/              all routes are mounted here (/api/v1/...)
      config/              environment variables, validated at startup
      core/                database, tenant isolation, errors, logging, rate limits
      db/migrations/       every database change (Knex)
      integrations/        SMS (MSG91) and WhatsApp (Meta) adapters
      modules/             one folder per feature: patients, clinic, hr-attendance, hr-payroll, …
    scripts/               org:create and seed:demo
    tests/                 unit tests; tests/integration = API + database tests
  web/                     React 19 + Vite + Tailwind; builds BOTH websites
    src/app/               staff/employee app (routes, layout)
    src/patient/           patient website
    src/features/          screens grouped by feature
docs/                      requirements, architecture, decisions (ADRs), deployment, operations
render.yaml                Render deployment (API, two websites, Redis)
docker-compose.yml         PostgreSQL + Redis for local development only
```

**Tech stack:**

| Area     | Tools                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| Frontend | React 19, Vite, Tailwind CSS 4, TanStack Query                                                                |
| Backend  | Node.js 22, Express 5, zod, pino                                                                              |
| Data     | PostgreSQL 17 via Knex ([why not MongoDB](docs/adr/0002-postgresql-over-mongodb.md)), Redis 7 for rate limits |
| Tests    | Vitest, Supertest, Testing Library, Playwright                                                                |

**How hospitals are kept apart:** every hospital-owned table has an `organization_id`. PostgreSQL
row-level security is enabled and forced on all of them, so even a buggy query can't read another
hospital's rows. Every request also filters by organization in code. Tests check this for every module.
See [docs/architecture/tenancy-model.md](docs/architecture/tenancy-model.md).

---

## Configuration

All settings are environment variables. [`.env.example`](.env.example) lists every one with a safe
placeholder and a comment. Copy it to `.env` for local use (git ignores `.env`). **Never commit real
keys or passwords**, and never put secrets in a `VITE_*` variable (those are visible in the browser).

The ones you'll most likely touch:

| Variable                                  | Purpose                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `APP_ENV`                                 | `development`, `test`, `staging` or `production`                              |
| `APP_SECRET_KEY`                          | Signs logins and codes. Must be a long random value in production             |
| `DATABASE_URL` / `DATABASE_MIGRATION_URL` | PostgreSQL connection (pooled / direct for migrations)                        |
| `REDIS_URL`                               | Redis connection                                                              |
| `FRONTEND_URL` / `PATIENT_SITE_URL`       | Public addresses of the two websites                                          |
| `SMS_PROVIDER`, `MSG91_*`                 | SMS codes and messages. `console` prints them locally; `msg91` sends real SMS |
| `WHATSAPP_*`                              | WhatsApp Business (optional)                                                  |
| `VITE_PATIENT_SITE_URL`                   | Patient website address used in QR codes and tracking links                   |

---

## Deploying

There are two deployments from the same code:

- **Demo** (free, fictional data, logins in [DEMO.md](DEMO.md)): branch `demo`, guide
  [docs/deployment/demo-setup.md](docs/deployment/demo-setup.md).
- **Pilot** (real hospitals, Render Starter): branch `main`, guide below.

The project deploys to **Render** (API, both websites, Redis) with **Neon** for PostgreSQL. Everything
Render needs is in [`render.yaml`](render.yaml). The full step-by-step guide, including SMS and WhatsApp
setup, is in **[docs/deployment/render-neon.md](docs/deployment/render-neon.md)**. Day-to-day
operations (monitoring, backups, incidents, adding a hospital) are in
[docs/operations/runbook.md](docs/operations/runbook.md).

---

## More documentation

| Topic                                    | Document                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Full API list                            | [docs/api.md](docs/api.md)                                                                           |
| Attendance, leave, payroll rules         | [docs/requirements/hr-attendance-leave-payroll.md](docs/requirements/hr-attendance-leave-payroll.md) |
| Patients, family links, consent          | [docs/requirements/patients-consent.md](docs/requirements/patients-consent.md)                       |
| Appointments and queue                   | [docs/requirements/appointments-queue.md](docs/requirements/appointments-queue.md)                   |
| WhatsApp and SMS                         | [docs/requirements/whatsapp-sms.md](docs/requirements/whatsapp-sms.md)                               |
| Messages to employees                    | [docs/requirements/employee-messages.md](docs/requirements/employee-messages.md)                     |
| Architecture and security                | [docs/architecture](docs/architecture)                                                               |
| Design decisions                         | [docs/adr](docs/adr)                                                                                 |
| What's done and what's next              | [docs/roadmap.md](docs/roadmap.md)                                                                   |
| Original requirements                    | [docs/healthos-platform-project-spec.json](docs/healthos-platform-project-spec.json)                 |
| Rules for contributors and coding agents | [AGENTS.md](AGENTS.md)                                                                               |

---

## Troubleshooting

| Problem                                              | Fix                                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `make migrate` can't connect                         | Is Docker running? Run `make up` and wait a few seconds                                               |
| Port 5432, 6379, 4000, 5173 or 5174 already in use   | Stop the other program, or change the port in `.env`                                                  |
| No SMS code arrives                                  | Locally, codes are printed in the `make dev` terminal. Check `SMS_PROVIDER=console` in `.env`         |
| "Mark attendance" says you're too far                | Set the branch location to where you are (Branches page) and raise the radius                         |
| Patient registration says "publish a privacy notice" | Patient privacy → Privacy notices → create and publish one                                            |
| The API warns about a superuser database role        | Use the `DATABASE_URL` from `.env.example` (the non-superuser `healthos_app` role)                    |
| Login works, then you're signed out                  | Use the address `localhost` consistently (not `127.0.0.1`), because the sign-in cookie is per address |

---

## Before real patient or employee data

This is a pilot build. Before entering real data:

1. Have a qualified Indian lawyer review privacy (DPDP Act), your privacy notice text, and where data
   is hosted (the Render/Neon setup in this repo stores data in Singapore).
2. Have your payroll adviser enter and approve the statutory rules (PF, ESI, PT, LWF, gratuity) and
   check TDS amounts. No rates are built in.
3. Set up real SMS (MSG91 with DLT-approved templates) and, optionally, WhatsApp Business.
4. Turn on database backups and test a restore ([runbook](docs/operations/runbook.md)).
5. Use custom domains with HTTPS and set up uptime monitoring.

The software provides configurable controls. **It does not by itself guarantee legal compliance.**
