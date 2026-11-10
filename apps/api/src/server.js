import { loadConfig } from './config/env.js';
import { createLogger } from './core/logger.js';
import { createDb } from './core/db.js';
import { createRedis } from './core/redis.js';
import { createRedisStore } from './core/rate-limit.js';
import { createApp } from './app.js';
import { createSmsSender } from './integrations/sms/index.js';
import { createWhatsAppSender } from './integrations/whatsapp/index.js';

const config = loadConfig();
const logger = createLogger(config);
const db = createDb(config);
const redis = createRedis(config);
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis connection error'));

const sms = createSmsSender(config, { logger });
if (sms.provider === 'none') {
  logger.warn(
    { reason: sms.reason },
    'SMS is not configured: employee OTP sign-in and attendance are unavailable',
  );
}

const whatsapp = createWhatsAppSender(config);
if (whatsapp.provider === 'none') {
  logger.info(
    { reason: whatsapp.reason },
    'WhatsApp is off: booking on WhatsApp and WhatsApp confirmations are unavailable',
  );
} else if (!config.WHATSAPP_APP_SECRET) {
  logger.warn('WHATSAPP_APP_SECRET is not set: incoming WhatsApp webhooks will be rejected');
}

const app = createApp({
  config,
  logger,
  db,
  sms,
  whatsapp,
  rateLimitStore: createRedisStore(redis),
  checks: {
    postgres: () => db.raw('select 1'),
    redis: async () => {
      if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
      return redis.ping();
    },
  },
});

// Row-level security does not apply to superusers or BYPASSRLS roles, so refuse to serve with one.
try {
  const { rows } = await db.raw(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  if (rows[0]?.rolsuper || rows[0]?.rolbypassrls) {
    const message =
      'The database role used by the API is a superuser or has BYPASSRLS; tenant isolation would not be enforced';
    if (config.APP_ENV === 'production' || config.APP_ENV === 'staging') {
      logger.fatal(message);
      process.exit(1);
    }
    logger.warn(`${message}. Use the non-superuser role from .env.example for local development.`);
  }
} catch (err) {
  logger.warn({ err: err.message }, 'could not verify database role at startup');
}

const server = app.listen(config.API_PORT, () => {
  logger.info({ port: config.API_PORT }, 'HealthOS API listening');
});

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  // Stop taking requests, let in-flight notifications and WhatsApp replies finish (max 10 s).
  server.close();
  const drained = Promise.allSettled([
    app.locals.whatsappProcessor?.drain(),
    app.locals.notifier?.drain(),
  ]);
  await Promise.race([drained, new Promise((r) => setTimeout(r, 10_000).unref())]);
  await Promise.allSettled([db.destroy(), redis.quit()]);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
