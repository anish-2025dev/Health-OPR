import { randomBytes } from 'node:crypto';
import { hashToken } from './tokens.js';

export const INVITE_DAYS = 7;

/**
 * Creates a one-time sign-in link for a user (a new hospital owner, or anyone who needs to set a new
 * password). Earlier unused links for the same user stop working. Returns the raw token, which is
 * shown once; only its hash is stored. Runs in the caller's transaction (tenant or system context).
 */
export async function createInvite(
  trx,
  { organizationId, userId, platformAdminId = null, userIdBy = null },
) {
  await trx('user_invites')
    .where({ organization_id: organizationId, user_id: userId })
    .whereNull('used_at')
    .whereNull('revoked_at')
    .update({ revoked_at: trx.fn.now() });
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
  await trx('user_invites').insert({
    organization_id: organizationId,
    user_id: userId,
    token_hash: hashToken(token),
    expires_at: expiresAt,
    created_by_platform_admin_id: platformAdminId,
    created_by_user_id: userIdBy,
  });
  return { token, expiresAt };
}

export const inviteUrl = (config, token) =>
  `${config.FRONTEND_URL.replace(/\/$/, '')}/invite?token=${encodeURIComponent(token)}`;
