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
import { createSmsSender } from '../../integrations/sms/index.js';
import { createWhatsAppSender } from '../../integrations/whatsapp/index.js';
import { createNotifier } from '../../modules/notifications/index.js';
import { createWhatsAppProcessor } from '../../modules/whatsapp/routes.js';
import { createOtpService } from '../../modules/otp/index.js';
import { createEmployeeLogin } from '../../modules/authentication/employee-login.js';
import { createMgtRouter } from '../../modules/mgt.routes.js';
import { createOpsRouter } from '../../modules/ops.routes.js';
import { createPlatformDomainRouter } from '../../modules/platform.routes.js';

/**
 * Versioned API surface mounted at /api/v1.
 *
 * Implements decoupled Suntek Ecosystem domain routers:
 * - /api/v1/mgt/*: Suntek-Mgt (HRMS & Workforce Operations)
 * - /api/v1/ops/*: Suntek-ops (Hospital Management & Operations)
 * - /api/v1/platform/*: Platform Console (Operator Control Plane)
 *
 * Also maintains complete backward compatibility by mounting domain routers
 * at root /api/v1/* so existing mobile clients, web applications, and tests
 * experience zero disruption.
 */
export function apiV1Router({ app, config, checks, db, rateLimitStore, sms, whatsapp, logger }) {
  const router = Router();
  router.use('/health', healthRouter({ checks }));

  if (!db) return router; // health-only mode (unit tests without a database)

  const tokens = createTokenService(config);
  const authService = createAuthService({ db, config, tokens });
  const authenticate = authenticateMiddleware({ tokens, authService });
  const smsSender = sms ?? createSmsSender(config, { logger });
  const otp = createOtpService({ db, config, sms: smsSender });
  const limiterStore = rateLimitStore ?? createMemoryStore();
  const whatsappSender = whatsapp ?? createWhatsAppSender(config);
  const notifier = createNotifier({ db, config, whatsapp: whatsappSender, sms: smsSender, logger });
  const whatsappProcessor = createWhatsAppProcessor({
    db,
    config,
    whatsapp: whatsappSender,
    logger,
  });
  if (app) {
    app.locals.whatsappProcessor = whatsappProcessor;
    app.locals.notifier = notifier;
  }
  if (config.APP_ENV !== 'test') {
    setInterval(() => whatsappProcessor.sweep().catch(() => {}), 60_000).unref();
  }
  const employeeLogin = createEmployeeLogin({ db, otp, authService });

  // 1. Shared Authentication & Tenancy Foundation
  router.use(
    '/auth',
    authRouter({
      config,
      authService,
      authenticate,
      rateLimitStore: limiterStore,
      employeeLogin,
    }),
  );
  router.use('/organizations', authenticate, organizationsRouter({ db }));
  router.use('/branches', authenticate, branchesRouter({ db }));
  router.use('/users', authenticate, usersRouter({ db }));
  router.use('/audit-logs', authenticate, auditRouter({ db }));

  // 2. Instantiate & Mount Decoupled Domain Routers Based on PRODUCT_MODE
  const productMode = config.PRODUCT_MODE || 'all';

  if (productMode === 'all' || productMode === 'mgt') {
    const mgtRouter = createMgtRouter({ db, config, authenticate, smsSender, otp, logger });
    router.use('/mgt', mgtRouter);
    router.use(mgtRouter);
  }

  if (productMode === 'all' || productMode === 'ops') {
    const opsRouter = createOpsRouter({
      db,
      config,
      authenticate,
      limiterStore,
      whatsappProcessor,
      whatsappSender,
      notifier,
      smsSender,
      logger,
    });
    router.use('/ops', opsRouter);
    router.use(opsRouter);
  }

  if (productMode === 'all' || productMode === 'platform') {
    const platformDomainRouter = createPlatformDomainRouter({
      db,
      config,
      rateLimitStore: limiterStore,
    });
    router.use('/platform', platformDomainRouter);
  }

  return router;
}
