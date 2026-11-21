import { Router } from 'express';
import { patientsRouter } from './patients/routes.js';
import { privacyRouter } from './patients/privacy.routes.js';
import { portalRouter } from './patients/portal.routes.js';
import {
  authenticatePatient as authenticatePatientMiddleware,
  createPatientTokens,
  patientAccountRouter,
  patientAuthRouter,
} from './patient-accounts/index.js';
import { appointmentsRouter, doctorsRouter, queueRouter, trackingRouter } from './clinic/routes.js';
import { whatsappSettingsRouter, whatsappWebhookRouter } from './whatsapp/routes.js';
import { analyticsRouter } from './analytics/index.js';
import { branchesRouter } from './branches/index.js';

/**
 * Suntek-ops (Hospital Management & Operations) Domain Router.
 *
 * Encapsulates all Hospital Operations modules:
 * - Patient master directory, family links, and duplicate detection/merge
 * - Patient privacy, DPDP consent tracking, and notice versioning
 * - Doctor profiles, weekly scheduling, and doctor time-off
 * - Appointment booking (row locks, idempotency) and live queue management
 * - Public tracking links (/public/track/:code) and waiting displays
 * - WhatsApp Cloud API bot and webhook processing
 * - Patient portal (/patient, /patient-auth, /public/clinics)
 * - Clinic operational analytics
 */
export function createOpsRouter({
  db,
  config,
  authenticate,
  limiterStore,
  whatsappProcessor,
  whatsappSender,
  notifier,
  smsSender,
  logger,
}) {
  const router = Router();

  router.use('/patients', authenticate, patientsRouter({ db }));
  router.use('/privacy', authenticate, privacyRouter({ db }));
  router.use('/doctors', authenticate, doctorsRouter({ db }));
  router.use('/appointments', authenticate, appointmentsRouter({ db, notifier }));
  router.use('/queue', authenticate, queueRouter({ db }));
  router.use('/analytics', authenticate, analyticsRouter({ db }));
  router.use('/branches', authenticate, branchesRouter({ db }));

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
  router.use('/patient', patientAccountRouter({ db, config, authenticate: authenticatePatient }));
  router.use(
    '/public/clinics',
    portalRouter({ db, rateLimitStore: limiterStore, authenticatePatient, notifier }),
  );

  return router;
}
