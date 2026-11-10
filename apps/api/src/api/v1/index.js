import { Router } from 'express';
import { healthRouter } from './health.routes.js';
import { createAuthService } from '../../modules/authentication/auth.service.js';
import { authRouter } from '../../modules/authentication/auth.routes.js';
import { authenticate as authenticateMiddleware } from '../../modules/authentication/middleware.js';
import { createTokenService } from '../../modules/authentication/tokens.js';
import { organizationsRouter } from '../../modules/organizations/index.js';
import { branchesRouter } from '../../modules/branches/index.js';
import { usersRouter } from '../../modules/staff-access/users.routes.js';
import { auditRouter } from '../../modules/audit/index.js';
import { createMemoryStore } from '../../core/rate-limit.js';

/**
 * Versioned API surface mounted at /api/v1. Each module exposes a router that is mounted here.
 * Every module except /health and /auth requires authentication.
 */
export function apiV1Router({ config, checks, db, rateLimitStore }) {
  const router = Router();
  router.use('/health', healthRouter({ checks }));

  if (!db) return router; // health-only mode (unit tests without a database)

  const tokens = createTokenService(config);
  const authService = createAuthService({ db, config, tokens });
  const authenticate = authenticateMiddleware({ tokens, authService });

  router.use(
    '/auth',
    authRouter({
      config,
      authService,
      authenticate,
      rateLimitStore: rateLimitStore ?? createMemoryStore(),
    }),
  );
  router.use('/organizations', authenticate, organizationsRouter({ db }));
  router.use('/branches', authenticate, branchesRouter({ db }));
  router.use('/users', authenticate, usersRouter({ db }));
  router.use('/audit-logs', authenticate, auditRouter({ db }));

  return router;
}
