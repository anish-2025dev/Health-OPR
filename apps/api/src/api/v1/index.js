import { Router } from 'express';
import { healthRouter } from './health.routes.js';

/**
 * Versioned API surface mounted at /api/v1. Each module under src/modules exposes a router that is
 * mounted here (for example /auth, /organizations, /patients, /hr/employees) as phases land.
 */
export function apiV1Router(deps) {
  const router = Router();
  router.use('/health', healthRouter(deps));
  return router;
}
