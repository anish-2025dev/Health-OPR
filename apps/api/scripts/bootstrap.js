#!/usr/bin/env node
/**
 * Deploy-time setup driven by environment variables, for hosts without a shell (e.g. Render's free
 * plan). Runs after migrations in the API build. Does nothing unless the variables are set, never
 * prints passwords, and never fails the deploy: problems are reported as warnings in the build log.
 *
 *   BOOTSTRAP_PLATFORM_ADMIN_EMAIL     create this platform-console login if it doesn't exist yet
 *   BOOTSTRAP_PLATFORM_ADMIN_PASSWORD  its first password (12+ chars; must be changed at first sign-in)
 *   BOOTSTRAP_PLATFORM_ADMIN_NAME      optional display name
 *
 *   DEMO_HOSPITAL_CODE                 create a demo hospital with fictional data and a login for every
 *   DEMO_PASSWORD                      role (once; skipped when the code already exists). 12+ chars.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { createDb, withSystem } from '../src/core/db.js';
import { hashPassword } from '../src/modules/authentication/passwords.js';

const env = process.env;
const warn = (msg) => console.warn(`[bootstrap] WARNING: ${msg}`);
const info = (msg) => console.log(`[bootstrap] ${msg}`);

const wantsAdmin = env.BOOTSTRAP_PLATFORM_ADMIN_EMAIL;
const wantsDemo = env.DEMO_HOSPITAL_CODE;
if (!wantsAdmin && !wantsDemo) {
  info('nothing to do (no BOOTSTRAP_PLATFORM_ADMIN_EMAIL or DEMO_HOSPITAL_CODE set)');
  process.exit(0);
}

const db = createDb(loadConfig());
try {
  if (wantsAdmin) {
    const email = wantsAdmin.trim().toLowerCase();
    const password = env.BOOTSTRAP_PLATFORM_ADMIN_PASSWORD ?? '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      warn('BOOTSTRAP_PLATFORM_ADMIN_EMAIL is not a valid email');
    else if (password.length < 12)
      warn('BOOTSTRAP_PLATFORM_ADMIN_PASSWORD must be at least 12 characters; no login created');
    else {
      const created = await withSystem(db, async (trx) => {
        const existing = await trx('platform_admins')
          .whereRaw('lower(email) = ?', [email])
          .first('id');
        if (existing) return false;
        await trx('platform_admins').insert({
          email,
          full_name: (env.BOOTSTRAP_PLATFORM_ADMIN_NAME || 'Platform Admin').trim().slice(0, 200),
          password_hash: await hashPassword(password),
          must_change_password: true,
        });
        await trx('platform_audit_logs').insert({
          action: 'platform.admin_created',
          metadata: { email, via: 'bootstrap' },
        });
        return true;
      });
      info(
        created
          ? `platform-console login created for ${email}. Sign in at <staff site>/platform and change the password; then you can delete BOOTSTRAP_PLATFORM_ADMIN_PASSWORD.`
          : `platform-console login ${email} already exists; left unchanged`,
      );
    }
  }

  if (wantsDemo) {
    const code = wantsDemo.trim().toLowerCase();
    const exists = await withSystem(db, (trx) =>
      trx('organizations').where({ slug: code }).first('id'),
    );
    if (exists) info(`demo hospital "${code}" already exists; left unchanged`);
    else if (!env.DEMO_PASSWORD || env.DEMO_PASSWORD.length < 12)
      warn('DEMO_PASSWORD (12+ characters) is required to create the demo hospital');
    else {
      const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed-demo.js');
      const r = spawnSync(process.execPath, [script, '--slug', code, '--allow-deployed'], {
        stdio: 'inherit',
        env,
      });
      if (r.status !== 0) warn('demo hospital could not be created (see the messages above)');
    }
  }
} catch (err) {
  warn(err.message);
} finally {
  await db.destroy();
}
