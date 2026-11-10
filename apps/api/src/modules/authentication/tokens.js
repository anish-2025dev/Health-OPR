import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

const ISSUER = 'healthos-api';
const AUDIENCE = 'healthos';

/** Short-lived access tokens (HS256 JWT) signed with APP_SECRET_KEY. */
export function createTokenService(config) {
  // In development an empty key gets a random per-process key (tokens stop working after a restart).
  const secret = config.APP_SECRET_KEY || randomBytes(48).toString('hex');
  const key = new TextEncoder().encode(secret);
  const ttlSeconds = config.ACCESS_TOKEN_EXPIRE_MINUTES * 60;

  return {
    ttlSeconds,
    async signAccessToken({ userId, organizationId, sessionId }) {
      return new SignJWT({ org: organizationId, sid: sessionId })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(userId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${ttlSeconds}s`)
        .sign(key);
    },
    /** Returns the claims, or null if the token is invalid or expired. */
    async verifyAccessToken(token) {
      try {
        const { payload } = await jwtVerify(token, key, {
          issuer: ISSUER,
          audience: AUDIENCE,
          algorithms: ['HS256'],
        });
        if (!payload.sub || !payload.org || !payload.sid) return null;
        return { userId: payload.sub, organizationId: payload.org, sessionId: payload.sid };
      } catch {
        return null;
      }
    },
  };
}

/** Opaque refresh token (256 bits). Only its SHA-256 hash is stored. */
export const newRefreshToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');
