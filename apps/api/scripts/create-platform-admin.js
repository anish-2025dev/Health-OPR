#!/usr/bin/env node
/**
 * Creates a platform admin: a member of YOUR team who onboards and manages client hospitals in the
 * platform console (/platform). Not a hospital account.
 *
 *   npm run platform:admin --workspace apps/api -- --email you@yourcompany.com --name "Your Name"
 *
 * Prints a one-time temporary password; it must be changed at first sign-in. In production, run it
 * from the Render Shell of healthos-api.
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../src/config/env.js';
import { createDb, withSystem } from '../src/core/db.js';
import {
  generateTemporaryPassword,
  hashPassword,
} from '../src/modules/authentication/passwords.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
const input = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    name: z.string().trim().min(2).max(200),
  })
  .safeParse(values);
if (!input.success) {
  console.error(
    'Usage: npm run platform:admin --workspace apps/api -- --email you@company.com --name "Full Name"',
  );
  process.exit(1);
}

const db = createDb(loadConfig());
const password = generateTemporaryPassword();
try {
  await withSystem(db, async (trx) => {
    await trx('platform_admins').insert({
      email: input.data.email,
      full_name: input.data.name,
      password_hash: await hashPassword(password),
      must_change_password: true,
    });
    await trx('platform_audit_logs').insert({
      action: 'platform.admin_created',
      metadata: { email: input.data.email, via: 'cli' },
    });
  });
  console.log(`
Platform admin created: ${input.data.email}
Temporary password (shown once): ${password}
Sign in at <staff site>/platform/login and set a new password.
`);
} catch (err) {
  if (err.code === '23505') console.error('A platform admin with this email already exists.');
  else console.error(err.message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
