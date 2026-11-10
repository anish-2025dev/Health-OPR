# Operations runbook

How to run HealthOS day to day once it is deployed ([deployment guide](../deployment/render-neon.md)).

## Monitoring

| What                             | How                                                                                                                                            | Alert when                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| API alive                        | Render health check on `GET /api/v1/health` (built in; Render restarts failing instances)                                                      | Render emails on failed deploys or health checks |
| API can reach database and Redis | External uptime monitor (for example UptimeRobot or Better Stack) on `GET /api/v1/health/ready` every 1–5 minutes                              | Status is not 200 for 2 checks in a row          |
| Websites up                      | Uptime monitor on both website URLs                                                                                                            | Not 200                                          |
| Errors                           | Render → healthos-api → Logs. Search `"level":50` (error) or `"level":60` (fatal). Every response has an `x-request-id`; search the log for it | Spikes in errors                                 |
| SMS / WhatsApp                   | Staff app → **WhatsApp & SMS** → Recent appointment confirmations; API logs warn on send failures                                              | Many `failed` rows                               |
| Disk / database size             | Neon dashboard                                                                                                                                 | Near your plan's limit                           |

Logs never contain passwords, OTPs, tokens, bank details or full identity numbers. Request bodies are
not logged.

## Daily and weekly checks (pilot)

- **Daily:** both websites open; `health/ready` is OK; at reception, the queue updates. Glance at the
  error count in the logs.
- **Weekly:** check notification outcomes (WhatsApp & SMS page); review the **Audit log** for unusual
  actions (role changes, payroll approvals, merges); check Neon storage.
- **Monthly:** run the restore drill below; review user accounts and remove anyone who has left.

## Backups and restore

Neon keeps a continuous history of the database (point-in-time restore). The length of history depends
on the plan's **history retention** setting, so set it to at least 7 days for the pilot.

**Restore drill (monthly, takes about 15 minutes):**

1. Neon → your project → **Branches → Create branch**, from the production branch **at a past
   time** (for example one hour ago).
2. Copy the new branch's direct connection string.
3. From a laptop or Codespace with the repository, check the data:

   ```bash
   psql '<restored branch direct url>' -c "select count(*) from organizations; select count(*) from patients; select max(created_at) from audit_logs;"
   ```

4. Write the date and result in your ops log, then delete the test branch.

**Real restore after data loss or corruption:**

1. Stop writes: in Render, **suspend** `healthos-api` (the websites will show errors, which is
   expected).
2. In Neon, create a branch from production at the time just before the problem, or use Neon's
   **restore** on the production branch.
3. If you restored to a new branch, point `DATABASE_URL` and `DATABASE_MIGRATION_URL` (Render →
   healthos-api) at that branch's role `healthos_app` connection strings.
4. Resume `healthos-api`, then check `health/ready` and sign in.
5. Record what happened, and tell affected hospitals if data was lost (see incidents below).

Optional extra copy: a nightly `pg_dump` from a scheduled job to encrypted storage you control. Never
store dumps in the repository or on personal laptops.

## Incidents

| Symptom                                          | First checks                                                                                                                                                         | Fix                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Websites load but nothing works                  | `health/ready`. If `postgres` fails, check Neon status and whether the compute is suspended or over quota                                                            | Wake or upgrade Neon; check `DATABASE_URL`                                          |
| `redis` fails in `health/ready`                  | Render → healthos-redis status                                                                                                                                       | Restart it. Rate limits fail open (logins still work, with database lockouts)       |
| Employees: "SMS isn't set up yet"                | `MSG91_*` variables on the API                                                                                                                                       | Set them (deployment guide Part 5)                                                  |
| SMS codes not arriving                           | MSG91 dashboard delivery reports; DLT template status                                                                                                                | Fix the template or sender ID in MSG91                                              |
| WhatsApp messages get no reply                   | Meta app → Webhooks shows failures? API logs "INVALID_SIGNATURE" means a wrong `WHATSAPP_APP_SECRET`. Is the hospital's Phone number ID saved in **WhatsApp & SMS**? | Correct the setting. Missed messages are retried every minute once processing works |
| "Mark attendance" fails for everyone at a branch | Branch location and radius (Branches page); indoor GPS accuracy                                                                                                      | Correct the location or raise the radius (for example to 30–50 m)                   |
| Deploy failed at "pre-deploy"                    | Render deploy logs show the migration error                                                                                                                          | Fix the migration and push again. The previous version is still serving             |

**Suspected data exposure or security incident:**

1. Contain the issue. Disable affected user accounts (Users & roles), suspend the API if needed, and
   rotate exposed keys (below).
2. Preserve evidence: export the relevant audit log entries and Render logs (and note the request IDs).
3. Assess which hospitals, patients or employees are affected, using the audit log.
4. Notify the affected hospitals. Follow your legal adviser's guidance on notifying the Data Protection
   Board and affected people within the legal timelines.
5. Fix the issue, add a test that would have caught it, and write a short post-incident note.

## Rotating secrets

| Secret                                          | Where                                                                         | Effect of rotating                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `APP_SECRET_KEY`                                | Render → healthos-api → Environment → generate a new value                    | Everyone (staff, employees, patients) must sign in again; open OTP codes stop working |
| Database password                               | Neon: `ALTER ROLE healthos_app PASSWORD '…'`, then update both URLs in Render | API restarts with the new password                                                    |
| `MSG91_AUTH_KEY`                                | MSG91 → regenerate, then update Render                                        | None                                                                                  |
| `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_APP_SECRET` | Meta → regenerate, then update Render                                         | None if updated together                                                              |
| `WHATSAPP_VERIFY_TOKEN`                         | Render → generate new, then re-verify the webhook in Meta                     | None                                                                                  |

Rotate immediately if a secret may have leaked, and at least yearly otherwise.

## Hospitals and people

- **Add a hospital:** deployment guide Part 4 (`org:create` from the Render Shell).
- **Staff member leaves:** Users & roles → disable the account (this ends their sessions immediately).
- **Employee leaves:** Employees → set status "Exited" with the exit date. Their mobile sign-in is
  disabled. Run their final payroll as usual.
- **Patient asks for their data, a correction or erasure:** reception records it on the patient profile
  (Privacy request). An admin handles it under **Patient privacy → Privacy requests** and records the
  outcome. Erasure of records that must be kept for legal or medical reasons needs your legal
  adviser's guidance; mark such requests "rejected" with the reason.
- **Duplicate patients:** Patient privacy → Duplicate review. Merging keeps one record and marks the
  other as merged; nothing is deleted.

## Rolling back

- **Code:** Render → service → Deploys → pick the last good deploy → **Rollback**.
- **Database:** migrations only move forward in production. If a new migration must be undone, write a
  new migration that reverses it, test it locally (`make migrate`, `make rollback`), and deploy. For
  data damage, use the restore steps above.
- **Approved payroll** can't be changed by design. Corrections go into the next run as adjustments.

## Useful commands (Render Shell on healthos-api)

```bash
npm run org:create --workspace apps/api -- --name "…" --slug … --owner-email … --owner-name "…"
```

```bash
npm run db:migrate
```
