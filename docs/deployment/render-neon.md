# Deploying HealthOS (Render + Neon)

This guide takes you from nothing to a running system that hospitals can use. Follow the parts in
order. Parts 1–4 are required. Parts 5–6 (SMS and WhatsApp) can be done later; until then, those
features show a friendly "not set up yet" message.

```
                          ┌──────────────────── Render (Singapore) ────────────────────┐
 Staff & employees ──▶    │  healthos-web      static site (staff/employee app)         │
                          │        │ /api/* rewrite                                     │
 Patients ─────────▶      │  healthos-patient  static site (patient website)            │
                          │        │ /api/* rewrite                                     │
 Meta WhatsApp ──────▶    │  healthos-api      Node web service (Express) ──────────────┼──TLS──▶ Neon PostgreSQL
                          │        │ private network                                    │         (Singapore)
                          │  healthos-redis    Key Value (rate limits), internal only   │
                          └─────────────────────────────────────────────────────────────┘
                          healthos-api ──▶ MSG91 (SMS)   healthos-api ──▶ Meta Graph API (WhatsApp)
```

Everything Render needs is in [`render.yaml`](../../render.yaml). **Never put real keys in that file
or in git.** You type them into the Render dashboard.

**Accounts you need:**

| Account                                    | Why                                    | When              |
| ------------------------------------------ | -------------------------------------- | ----------------- |
| GitHub                                     | Holds the code; Render deploys from it | Before you start  |
| Render (render.com)                        | Runs the API and the two websites      | Before you start  |
| Neon (neon.tech)                           | PostgreSQL database                    | Before you start  |
| MSG91 + DLT registration                   | SMS codes for employees and patients   | Part 5            |
| Meta Business + WhatsApp Business Platform | WhatsApp booking and confirmations     | Part 6 (optional) |

---

## Part 1: Create the database (Neon)

1. Sign in at neon.tech and **create a project**:
   - Region: **AWS Asia Pacific (Singapore)**, close to the Render services.
   - PostgreSQL version **17**.
   - Database name: `healthos`.
2. Open the **SQL Editor** (database `healthos`) and create the app's own role. Generate a long random
   password, for example with a password manager. Row-level security, which keeps hospitals apart,
   does not apply to superusers or `BYPASSRLS` roles. The API refuses to start in production if
   connected as one.

   ```sql
   CREATE ROLE healthos_app WITH LOGIN PASSWORD '<long random password>' NOBYPASSRLS;
   ALTER DATABASE healthos OWNER TO healthos_app;
   ALTER SCHEMA public OWNER TO healthos_app;
   ```

3. Click **Connect**, choose role `healthos_app` and database `healthos`, and copy **two** connection
   strings:
   - **Pooled** (host contains `-pooler`). This becomes `DATABASE_URL`.
   - **Direct** (pooling switched off). This becomes `DATABASE_MIGRATION_URL`.

   Both must end with `?sslmode=require`; Neon adds it.

4. Recommended for a live pilot: in the branch settings, **turn off scale-to-zero** for production, so
   the first request in the morning isn't slow. Set **history retention** (point-in-time restore) to
   at least 7 days. See the [runbook](../operations/runbook.md#backups-and-restore).

## Part 2: Create the services (Render Blueprint)

1. Make sure the code is on GitHub (branch `main`) and CI is green.
2. In Render: **New → Blueprint**, connect the repository, and choose `render.yaml`.
3. Render shows every variable marked `sync: false`. Fill them in:

   | Service      | Variable                                                           | Value                                                              |
   | ------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
   | healthos-api | `DATABASE_URL`                                                     | Neon **pooled** connection string                                  |
   | healthos-api | `DATABASE_MIGRATION_URL`                                           | Neon **direct** connection string                                  |
   | healthos-api | `FRONTEND_URL`                                                     | `https://healthos-web.onrender.com` (check the real URL in step 5) |
   | healthos-api | `PATIENT_SITE_URL`                                                 | `https://healthos-patient.onrender.com` (check in step 5)          |
   | healthos-api | `MSG91_AUTH_KEY`, `MSG91_OTP_TEMPLATE_ID`                          | Leave empty for now (Part 5)                                       |
   | healthos-api | `MSG91_APPOINTMENT_TEMPLATE_ID`, `MSG91_MESSAGE_ALERT_TEMPLATE_ID` | Leave empty for now (Part 5)                                       |
   | healthos-api | `WHATSAPP_*`                                                       | Leave empty for now (Part 6)                                       |
   | healthos-web | `VITE_PATIENT_SITE_URL`                                            | Same as `PATIENT_SITE_URL`                                         |

   Render generates `APP_SECRET_KEY` and `WHATSAPP_VERIFY_TOKEN` and connects `REDIS_URL` itself.

4. Click **Apply**. Render creates four things: `healthos-api`, `healthos-web`, `healthos-patient` and
   `healthos-redis`. On every API deploy it runs:
   - build: `npm ci && npm run db:migrate` (installs, then creates or updates tables; a failure stops
     the deploy, and the old version keeps running). On a paid plan you can move the migration to a
     `preDeployCommand` instead
   - start: `npm run start --workspace apps/api`
   - health check: `GET /api/v1/health`
5. **Check the URLs Render actually assigned** (shown on each service). If any differ from the names
   above, for example `healthos-api-ab12.onrender.com`:
   - in `render.yaml`, change the two `/api/*` rewrite destinations to the real API URL, commit and
     push;
   - in the dashboard, update `FRONTEND_URL`, `PATIENT_SITE_URL` (API) and `VITE_PATIENT_SITE_URL`
     (web);
   - redeploy the web and patient sites. `VITE_*` values are built into the site.

## Part 3: Check that it works

Run these (use your real API URL):

```bash
curl https://healthos-api.onrender.com/api/v1/health
```

```bash
curl https://healthos-api.onrender.com/api/v1/health/ready
```

The second must return `{"status":"ok","dependencies":{"postgres":"ok","redis":"ok"}}`.

Then open both websites. The staff app shows a sign-in page. The patient website shows "Sign in with your
phone number".

## Part 4: Create the first hospital

In Render, open **healthos-api → Shell** and run (with the hospital's real name and the owner's real
email):

```bash
npm run org:create --workspace apps/api -- --name "Sunrise Clinic" --slug sunrise-clinic --owner-email owner@sunriseclinic.in --owner-name "Owner Name"
```

- `--slug` is the **hospital code** that patients and employees type. Use lowercase letters, digits and
  dashes, and keep it short.
- It prints a **temporary password once**. Send it to the owner privately. They must change it at
  first sign-in.

The owner signs in at the staff app and sets up, in this order:

1. **Branches:** address, and the location and radius used for attendance.
2. **Users & roles:** reception, HR, payroll, doctors and managers.
3. **Company setup:** departments, designations and shifts.
4. **Employees:** with their mobile numbers.
5. **Doctors:** with consultation hours.
6. **Patient privacy → Privacy notices:** write the notice with a lawyer, then publish it.
7. **Patient privacy → Clinic QR page:** download and print the QR code for the desk.
8. Payroll: **Payroll → Setup**, then statutory rules entered and approved with the payroll adviser.

Repeat Part 4 for each new hospital. Hospitals never see each other's data.

## Part 5: Turn on SMS (MSG91)

SMS is needed for employee sign-in and attendance codes, and patient website sign-in codes. Optional
SMS covers appointment confirmations and "new message" alerts.

1. Create an MSG91 account, and complete **DLT registration** (required in India): register your
   business entity and a sender ID (header).
2. Create and get approval for these templates. The wording is yours; keep medical details out.

   | Purpose                                    | Variables (in this order) | Render variable                                                               |
   | ------------------------------------------ | ------------------------- | ----------------------------------------------------------------------------- |
   | One-time code (required)                   | the code                  | `MSG91_OTP_TEMPLATE_ID`; set `MSG91_OTP_VARIABLE` to the code variable's name |
   | Appointment confirmation (optional)        | token, date, time, link   | `MSG91_APPOINTMENT_TEMPLATE_ID`; names in `MSG91_APPOINTMENT_VARIABLES`       |
   | New message alert for employees (optional) | organization name, link   | `MSG91_MESSAGE_ALERT_TEMPLATE_ID`; names in `MSG91_MESSAGE_ALERT_VARIABLES`   |

3. In Render (healthos-api → Environment), set `MSG91_AUTH_KEY` and the template IDs, then save. The
   service restarts.
4. Test: open the employee sign-in page and request a code for a real staff mobile number.

## Part 6: Turn on WhatsApp (optional)

1. In Meta Business: create a **WhatsApp Business account**, add a phone number for each hospital,
   and create a **system user** with a permanent access token that has WhatsApp permissions.
2. Create a message **template** for appointment confirmations with four body parameters, in this
   order: token, date, time, link. Keep medical wording out. Wait for approval.
3. In Render (healthos-api → Environment), set:

   | Variable                        | Value                                                    |
   | ------------------------------- | -------------------------------------------------------- |
   | `WHATSAPP_PROVIDER`             | `meta`                                                   |
   | `WHATSAPP_ACCESS_TOKEN`         | the system-user token                                    |
   | `WHATSAPP_APP_SECRET`           | Meta app → Settings → Basic → App secret                 |
   | `WHATSAPP_GRAPH_API_VERSION`    | the version shown in your Meta app (for example `v21.0`) |
   | `WHATSAPP_APPOINTMENT_TEMPLATE` | the approved template's name                             |
   | `WHATSAPP_TEMPLATE_LANGUAGE`    | the template's language code (for example `en`)          |

   `WHATSAPP_VERIFY_TOKEN` was generated by Render; copy its value.

4. In the Meta app → WhatsApp → Configuration, set the webhook:
   - Callback URL: `https://<your API URL>/api/v1/webhooks/whatsapp`
   - Verify token: the `WHATSAPP_VERIFY_TOKEN` value
   - Subscribe to the **messages** field.
5. Each hospital's owner opens **WhatsApp & SMS** in the staff app and enters their number's **Phone
   number ID** (WhatsApp Manager → Phone numbers).
6. Test: from a phone registered as a patient, send "hi" to the hospital's WhatsApp number. You should
   get the menu.

## Part 7: Custom domains (recommended before going live)

In Render, add a custom domain to each service, for example `app.yourcompany.in` (staff),
`patients.yourcompany.in` (patients) and `api.yourcompany.in` (API). Render issues HTTPS certificates
automatically. Then:

- update `FRONTEND_URL`, `PATIENT_SITE_URL` (API) and `VITE_PATIENT_SITE_URL` (web);
- point the `/api/*` rewrites in `render.yaml` at the API's domain;
- update the WhatsApp webhook URL in Meta, if used;
- redeploy both websites and **reprint the clinic QR codes** (they contain the patient website address).

## Updating the system

- Push to `main`. GitHub CI runs lint, tests, migrations and a secret scan. Render deploys **only
  after CI passes** (`autoDeployTrigger: checksPass`), and only the services whose files changed.
- Database changes run automatically before the new API starts. If a migration fails, the deploy
  stops and the old version keeps serving.
- To roll back the code, use **Rollback** on the service's Deploys page in Render. Database changes
  are not undone automatically; see the [runbook](../operations/runbook.md#rolling-back).

## Plans and cost

| Service                        | Plan in `render.yaml`          | Notes                                                                                                                       |
| ------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| healthos-api                   | `free` (current)               | Sleeps after ~15 minutes idle, so the first request after a pause is slow. Move to `starter` before the clinic relies on it |
| healthos-web, healthos-patient | static (free)                  | Served from a CDN                                                                                                           |
| healthos-redis                 | `free`                         | Used for rate limits; no persistence needed                                                                                 |
| Neon                           | Free tier possible for a pilot | Paid tier for longer restore history and no scale-to-zero                                                                   |

**Moving the API to a paid plan** (recommended for a live clinic, so the reception screen never waits
for the server to wake up): in `render.yaml` set `plan: starter`, change the API `buildCommand` back to
`npm ci`, and add `preDeployCommand: npm run db:migrate`.

## Before real patient or employee data

- Have a lawyer review DPDP Act obligations, the privacy notice, and **hosting outside India**
  (Render and Neon in Singapore store data outside India).
- Have the payroll adviser enter and approve statutory rules.
- Test a database restore ([runbook](../operations/runbook.md#backups-and-restore)).
- Set up uptime monitoring on `/api/v1/health/ready`.
- Use custom domains.
