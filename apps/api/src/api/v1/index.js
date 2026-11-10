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
import { createOtpService } from '../../modules/otp/index.js';
import { createEmployeeLogin } from '../../modules/authentication/employee-login.js';
import { attendanceRouter, selfAttendanceRouter } from '../../modules/hr-attendance/routes.js';
import { leaveRouter, selfLeaveRouter } from '../../modules/hr-leave/routes.js';
import { payrollRouter, selfPayslipRouter } from '../../modules/hr-payroll/routes.js';
import { statutoryRouter } from '../../modules/hr-statutory/routes.js';
import { patientsRouter } from '../../modules/patients/routes.js';
import { privacyRouter } from '../../modules/patients/privacy.routes.js';
import { portalRouter } from '../../modules/patients/portal.routes.js';

/**
 * Versioned API surface mounted at /api/v1. Each module exposes a router that is mounted here.
 * Every module except /health and /auth requires authentication.
 */
export function apiV1Router({ config, checks, db, rateLimitStore, sms, logger }) {
  const router = Router();
  router.use('/health', healthRouter({ checks }));

  if (!db) return router; // health-only mode (unit tests without a database)

  const tokens = createTokenService(config);
  const authService = createAuthService({ db, config, tokens });
  const authenticate = authenticateMiddleware({ tokens, authService });
  const smsSender = sms ?? createSmsSender(config, { logger });
  const otp = createOtpService({ db, config, sms: smsSender });
  const limiterStore = rateLimitStore ?? createMemoryStore();
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
  router.use('/me', authenticate, selfAttendanceRouter({ db, otp }));
  router.use('/leave', authenticate, leaveRouter({ db }));
  router.use('/payroll/statutory', authenticate, statutoryRouter({ db }));
  router.use('/payroll', authenticate, payrollRouter({ db }));
  router.use('/patients', authenticate, patientsRouter({ db }));
  router.use('/privacy', authenticate, privacyRouter({ db }));
  // Public clinic portal (QR landing page): no staff login; uses its own phone-verified token.
  router.use(
    '/public/clinics',
    portalRouter({ db, config, sms: smsSender, rateLimitStore: limiterStore }),
  );

  return router;
}
