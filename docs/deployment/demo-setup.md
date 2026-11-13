# Setting up the DEMO (free) from zero

The demo is a separate copy of HealthOS for showing people. It costs nothing:

- **Code:** the `demo` branch of the same GitHub repository.
- **Hosting:** Render free plan: `healthos-demo-api`, `healthos-demo-web`, `healthos-demo-patient` and
  `healthos-demo-redis` (defined in `render.yaml` on the `demo` branch).
- **Database:** its own **free Neon project** (never the pilot's database).
- **Data:** a demo hospital (code `demo-hospital`) with 2 logins of every type, created automatically
  on the first deploy. Logins and a guided tour are in [DEMO.md](../../DEMO.md).
- **Sign-in codes:** shown on screen for the demo's fictional numbers (`SMS_DEMO_CODES=true`). No SMS
  account is needed.

Everything below is done in a web browser. You need free accounts on **GitHub**, **Neon** and
**Render**.

---

## Step 1: Create the demo database (Neon)

1. Go to **neon.tech** → sign in → **New project**.
2. Name: `healthos-demo`. PostgreSQL version: **17**. Region: **AWS Asia Pacific (Singapore)**. Click
   **Create**.
3. In the project, open **Databases** and create a database named `healthos`.
4. Open the **SQL Editor**, choose database `healthos`, paste this, and replace the password with a long
   random one (you won't need to type it again):

   ```sql
   CREATE ROLE healthos_app WITH LOGIN PASSWORD 'replace-with-a-long-random-password' NOBYPASSRLS;
   ALTER DATABASE healthos OWNER TO healthos_app;
   ALTER SCHEMA public OWNER TO healthos_app;
   ```

   Click **Run**.

5. Click **Connect**, choose role `healthos_app` and database `healthos`, and copy **two** connection
   strings into a note:
   - with **Connection pooling ON** (the address contains `-pooler`): this is the **pooled** string;
   - with **Connection pooling OFF**: this is the **direct** string.

## Step 2: Create the demo services (Render Blueprint)

1. Go to **render.com** → sign in with GitHub.
2. **New → Blueprint** → choose the `health-opr` repository → **Branch: `demo`** → Blueprint file:
   `render.yaml` → **Connect**.
3. Render lists the services it will create and asks for the empty settings. Fill them in:

   | Service           | Setting                  | Value                                                                     |
   | ----------------- | ------------------------ | ------------------------------------------------------------------------- |
   | healthos-demo-api | `DATABASE_URL`           | the **pooled** string from Step 1                                         |
   | healthos-demo-api | `DATABASE_MIGRATION_URL` | the **direct** string from Step 1                                         |
   | healthos-demo-api | `FRONTEND_URL`           | `https://healthos-demo-web.onrender.com` (fix in Step 4 if different)     |
   | healthos-demo-api | `PATIENT_SITE_URL`       | `https://healthos-demo-patient.onrender.com` (fix in Step 4 if different) |
   | healthos-demo-web | `VITE_PATIENT_SITE_URL`  | same as `PATIENT_SITE_URL`                                                |

   Leave everything else as it is. The demo password, hospital code and on-screen codes are already
   set in the demo branch's `render.yaml`.

4. Click **Apply**. The first deploy takes about 5–10 minutes.

## Step 3: Check the first deploy

1. Render → **healthos-demo-api** → **Logs**. Near the end of the build you should see
   `Demo hospital created: Sunrise Demo Hospital (hospital code: demo-hospital)`.
2. Open `https://healthos-demo-api.onrender.com/api/v1/health/ready` (use the real API address). It
   should show `"status":"ok"`.

## Step 4: Make sure the addresses match

Render may add letters to a name if it's taken (for example `healthos-demo-api-x1y2.onrender.com`).
Compare each service's address in the Render dashboard with what you entered:

- **API address different?** On GitHub, open `render.yaml` **on the `demo` branch** and, in the two
  `/api/*` rewrite lines, change `https://healthos-demo-api.onrender.com` to the real address. Commit.
  Render redeploys the websites.
- **Website addresses different?** In Render, update `FRONTEND_URL` and `PATIENT_SITE_URL` on
  `healthos-demo-api` and `VITE_PATIENT_SITE_URL` on `healthos-demo-web`, then redeploy
  `healthos-demo-web`.

Write the final addresses at the top of `DEMO.md`.

## Step 5: Try it

Open the staff app and sign in as `owner@demo-hospital.test` with `HealthOS-Demo-2026`. Then follow the
10-minute tour in [DEMO.md](../../DEMO.md).

---

## Keeping the demo up to date

New features are built on `main`, then copied to the demo:

1. On GitHub: **Pull requests → New** → base `demo` ← compare `main` → **Create** → **Merge**.
2. If GitHub reports a conflict, it is almost always in `render.yaml`. **Keep the demo branch's
   version** of that file (free plan, `healthos-demo-*` names, demo settings).
3. Render deploys the demo automatically after the checks pass.

Things that differ on the `demo` branch (and only there): `render.yaml` (free plan, demo service names,
`SMS_DEMO_CODES=true`, `DEMO_HOSPITAL_CODE`, `DEMO_PASSWORD`). The application code is identical to
`main`.

## Free-plan limits

- The API sleeps after ~15 minutes idle; the next request takes about a minute.
- Render free web services have a monthly hours allowance that is enough for one always-used demo.
- Neon free: 0.5 GB storage, plenty for the demo.
- No custom domain is needed.
