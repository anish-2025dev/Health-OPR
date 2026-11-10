import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { withSystem, withTenant } from '../../core/db.js';
import { notFound } from '../../core/errors.js';
import { auditContext, recordAudit } from '../audit/index.js';
import { PERMISSIONS, requirePermission } from '../staff-access/permissions.js';

const present = (o) => ({
  id: o.id,
  name: o.name,
  legalName: o.legal_name,
  slug: o.slug,
  status: o.status,
  timezone: o.timezone,
  createdAt: o.created_at,
});

const isValidTimezone = (tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const updateSchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    legalName: z.string().trim().max(200).nullable().optional(),
    timezone: z.string().refine(isValidTimezone, 'Unknown timezone').optional(),
  })
  .strict();

export function organizationsRouter({ db }) {
  const router = Router();

  router.get('/current', async (req, res) => {
    const org = await withTenant(db, req.auth.organizationId, (trx) =>
      trx('organizations').where({ id: req.auth.organizationId }).first(),
    );
    if (!org) throw notFound();
    res.json(present(org));
  });

  router.patch('/current', requirePermission(PERMISSIONS.ORGANIZATION_MANAGE), async (req, res) => {
    const body = validate(updateSchema, req.body);
    const org = await withTenant(db, req.auth.organizationId, async (trx) => {
      const changes = {};
      if (body.name !== undefined) changes.name = body.name;
      if (body.legalName !== undefined) changes.legal_name = body.legalName;
      if (body.timezone !== undefined) changes.timezone = body.timezone;
      const [updated] = await trx('organizations')
        .where({ id: req.auth.organizationId })
        .update({ ...changes, updated_at: trx.fn.now() })
        .returning('*');
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'organization.updated',
        entityType: 'organization',
        entityId: req.auth.organizationId,
        metadata: { fields: Object.keys(body) },
      });
      return updated;
    });
    res.json(present(org));
  });

  return router;
}

/**
 * Creates an organization with a main branch and its first owner. Used by the bootstrap script (and
 * later by the platform admin console). Runs in the system context because the tenant doesn't exist yet.
 */
export async function createOrganizationWithOwner(db, { name, slug, owner, branch, passwordHash }) {
  return withSystem(db, async (trx) => {
    const [org] = await trx('organizations').insert({ name, slug }).returning('*');
    const [mainBranch] = await trx('branches')
      .insert({ organization_id: org.id, name: branch.name, code: branch.code })
      .returning('*');
    const [user] = await trx('users')
      .insert({
        organization_id: org.id,
        email: owner.email,
        full_name: owner.fullName,
        password_hash: passwordHash,
        must_change_password: true,
      })
      .returning('*');
    await trx('user_role_assignments').insert({
      organization_id: org.id,
      user_id: user.id,
      role_key: 'organization_owner',
      branch_id: null,
    });
    await recordAudit(trx, {
      organizationId: org.id,
      actorUserId: null,
      action: 'organization.created',
      entityType: 'organization',
      entityId: org.id,
      metadata: { ownerUserId: user.id, source: 'bootstrap' },
    });
    return { organization: org, branch: mainBranch, owner: user };
  });
}
