import { Router } from 'express';
import { platformRouter } from './platform/index.js';

/**
 * Platform Console Domain Router.
 *
 * Encapsulates Operator Control Plane endpoints:
 * - Operator authentication and session tokens
 * - Hospital/organization onboarding and branch creation
 * - One-time owner invitation link generation and redemption
 * - Organization suspension and reactivation
 * - Platform audit logging
 */
export function createPlatformDomainRouter({ db, config, rateLimitStore }) {
  const router = Router();
  router.use('/', platformRouter({ db, config, rateLimitStore }));
  return router;
}
