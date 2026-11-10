import { loadConfig } from './config/env.js';
import { createLogger } from './core/logger.js';
import { createDb } from './core/db.js';
import { createRedis } from './core/redis.js';
import { createApp } from './app.js';

const config = loadConfig();
const logger = createLogger(config);
const db = createDb(config);
const redis = createRedis(config);
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis connection error'));

const app = createApp({
  config,
  logger,
  checks: {
    postgres: () => db.raw('select 1'),
    redis: async () => {
      if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
      return redis.ping();
    },
  },
});

const server = app.listen(config.API_PORT, () => {
  logger.info({ port: config.API_PORT }, 'HealthOS API listening');
});

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close();
  await Promise.allSettled([db.destroy(), redis.quit()]);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
