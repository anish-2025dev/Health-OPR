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
import { orgStructureRouters } from '../../modules/org-structure/index.js';
import { employeesRouter } from '../../modules/hr-employees/index.js';
import { createMemoryStore } from '../../core/rate-limit.js';
import { createSmsSender } from '../../integrations/sms/index.js';
import { createWhatsAppSender } from '../../integrations/whatsapp/index.js';
import { createNotifier } from '../../modules/notifications/index.js';
import {
  createWhatsAppProcessor,
  whatsappSettingsRouter,
  whatsappWebhookRouter,
} from '../../modules/whatsapp/routes.js';
import { createOtpService } from '../../modules/otp/index.js';
import { createEmployeeLogin } from '../../modules/authentication/employee-login.js';
import { attendanceRouter, selfAttendanceRouter } from '../../modules/hr-attendance/routes.js';
import { leaveRouter, selfLeaveRouter } from '../../modules/hr-leave/routes.js';
import { payrollRouter, selfPayslipRouter } from '../../modules/hr-payroll/routes.js';
import { statutoryRouter } from '../../modules/hr-statutory/routes.js';
import { messagesRouter, selfMessagesRouter } from '../../modules/messages/index.js';
import { analyticsRouter } from '../../modules/analytics/index.js';
import { patientsRouter } from '../../modules/patients/routes.js';
import { privacyRouter } from '../../modules/patients/privacy.routes.js';
import { portalRouter } from '../../modules/patients/portal.routes.js';
import {
  authenticatePatient as authenticatePatientMiddleware,
  createPatientTokens,
  patientAccountRouter,
  patientAuthRouter,
} from '../../modules/patient-accounts/index.js';
import {
  appointmentsRouter,
  doctorsRouter,
  queueRouter,
  trackingRouter,
} from '../../modules/clinic/routes.js';

/**
 * Versioned API surface mounted at /api/v1. Each module exposes a router that is mounted here.
 * Every module except /health and /auth requires authentication.
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

  const structure = orgStructureRouters({ db });
  router.use('/departments', authenticate, structure.departments);
  router.use('/designations', authenticate, structure.designations);
  router.use('/shifts', authenticate, structure.shifts);
  router.use('/holidays', authenticate, structure.holidays);
  router.use('/hr/employees', authenticate, employeesRouter({ db }));
  router.use('/attendance', authenticate, attendanceRouter({ db }));
  router.use('/me/leave', authenticate, selfLeaveRouter({ db }));
  router.use('/me/payslips', authenticate, selfPayslipRouter({ db }));
  router.use('/me/messages', authenticate, selfMessagesRouter({ db }));
  router.use('/me', authenticate, selfAttendanceRouter({ db, otp }));
  router.use('/leave', authenticate, leaveRouter({ db }));
  router.use('/messages', authenticate, messagesRouter({ db, config, sms: smsSender, logger }));
  router.use('/payroll/statutory', authenticate, statutoryRouter({ db }));
  router.use('/payroll', authenticate, payrollRouter({ db }));
  router.use('/patients', authenticate, patientsRouter({ db }));
  router.use('/analytics', authenticate, analyticsRouter({ db }));
  router.use('/privacy', authenticate, privacyRouter({ db }));
  router.use('/doctors', authenticate, doctorsRouter({ db }));
  router.use('/appointments', authenticate, appointmentsRouter({ db, notifier }));
  router.use('/queue', authenticate, queueRouter({ db }));
  router.use(
    '/webhooks/whatsapp',
    whatsappWebhookRouter({ db, config, processor: whatsappProcessor, logger }),
  );
  router.use(
    '/integrations',
    authenticate,
    whatsappSettingsRouter({ db, config, whatsapp: whatsappSender }),
  );
  // Patient's live queue link (token, position and estimate only).
  router.use('/public/track', trackingRouter({ db, rateLimitStore: limiterStore }));
  // Public clinic portal (QR landing page): no staff login; uses its own phone-verified token.
  const patientTokens = createPatientTokens(config);
  const authenticatePatient = authenticatePatientMiddleware({ db, tokens: patientTokens });
  router.use(
    '/patient-auth',
    patientAuthRouter({
      db,
      config,
      sms: smsSender,
      tokens: patientTokens,
      rateLimitStore: limiterStore,
    }),
  );
  router.use('/patient', patientAccountRouter({ db, authenticate: authenticatePatient }));
  router.use(
    '/public/clinics',
    portalRouter({ db, rateLimitStore: limiterStore, authenticatePatient, notifier }),
  );

  return router;
}
