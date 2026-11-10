#!/usr/bin/env node
/**
 * Creates an organization (tenant) with a main branch and its first owner account.
 *
 *   npm run org:create -- --name "Sunrise Clinic" --slug sunrise-clinic \
 *     --owner-email owner@example.com --owner-name "Asha Rao" [--branch-name "Main" --branch-code MAIN]
 *
 * Prints a one-time temporary password. The owner must change it at first login.
 * Use synthetic details in development. In production, run it from the Render shell.
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../src/config/env.js';
import { createDb } from '../src/core/db.js';
import { createOrganizationWithOwner } from '../src/modules/organizations/index.js';
import {
  generateTemporaryPassword,
  hashPassword,
} from '../src/modules/authentication/passwords.js';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    slug: { type: 'string' },
    'owner-email': { type: 'string' },
    'owner-name': { type: 'string' },
    'branch-name': { type: 'string', default: 'Main' },
    'branch-code': { type: 'string', default: 'MAIN' },
  },
});

const input = z
  .object({
    name: z.string().min(2).max(200),
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, 'lowercase letters, digits, dashes'),
    'owner-email': z.string().email(),
    'owner-name': z.string().min(2).max(200),
    'branch-name': z.string().min(2).max(200),
    'branch-code': z.string().regex(/^[A-Z0-9-]{2,20}$/),
  })
  .safeParse(values);

if (!input.success) {
  console.error('Invalid arguments:');
  for (const issue of input.error.issues)
    console.error(`  --${issue.path.join('.')}: ${issue.message}`);
  console.error(
    '\nUsage: npm run org:create -- --name "Clinic name" --slug clinic-slug --owner-email a@b.com --owner-name "Full Name"',
  );
  process.exit(1);
}

const config = loadConfig();
const db = createDb(config);
const temporaryPassword = generateTemporaryPassword();

try {
  const v = input.data;
  const { organization, owner } = await createOrganizationWithOwner(db, {
    name: v.name,
    slug: v.slug,
    owner: { email: v['owner-email'].toLowerCase(), fullName: v['owner-name'] },
    branch: { name: v['branch-name'], code: v['branch-code'] },
    passwordHash: await hashPassword(temporaryPassword),
  });
  console.log(`Created organization "${organization.name}" (${organization.slug})`);
  console.log(`Owner: ${owner.email}`);
  console.log(
    `Temporary password (shown once, must be changed at first login): ${temporaryPassword}`,
  );
} catch (err) {
  if (err.code === '23505') {
    console.error('An organization with this slug, or a user with this email, already exists.');
  } else {
    console.error(`Failed: ${err.message}`);
  }
  process.exitCode = 1;
} finally {
  await db.destroy();
}
