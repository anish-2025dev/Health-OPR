import { AppError, unauthorized } from '../../core/errors.js';

/** Routes a user with a temporary password may still call. */
const ALLOWED_WHILE_PASSWORD_CHANGE_REQUIRED = new Set([
  'GET /api/v1/auth/me',
  'POST /api/v1/auth/change-password',
  'POST /api/v1/auth/logout',
]);

/**
 * Verifies the Bearer access token, then loads the user, roles and permissions on every request, so
 * revoked sessions, disabled users and suspended organizations are rejected immediately.
 */
export function authenticate({ tokens, authService }) {
  return async (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return next(unauthorized());

    const claims = await tokens.verifyAccessToken(token);
    if (!claims) return next(unauthorized('Access token is invalid or expired'));

    req.auth = await authService.loadAuthContext(claims);

    const route = `${req.method} ${req.baseUrl}${req.path}`.replace(/\/$/, '');
    if (req.auth.mustChangePassword && !ALLOWED_WHILE_PASSWORD_CHANGE_REQUIRED.has(route)) {
      return next(
        new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Please set a new password to continue'),
      );
    }
    next();
  };
}

export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'healthos-web';

/**
 * Cookie-authenticated routes (refresh, logout) need a custom header. Browsers can't add one to a
 * cross-site form post, and CORS only allows FRONTEND_URL to send it, which blocks CSRF.
 */
export function requireCsrfHeader(req, res, next) {
  if (req.get(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
    return next(new AppError(403, 'CSRF_CHECK_FAILED', 'Missing or invalid request header'));
  }
  next();
}
