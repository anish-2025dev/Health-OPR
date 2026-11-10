import { Router } from 'express';

const CHECK_TIMEOUT_MS = 2000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * GET /health        liveness: the process is up (no dependency checks).
 * GET /health/ready  readiness: PostgreSQL and Redis are reachable.
 * Responses contain no infrastructure details (hosts, versions, error text).
 */
export function healthRouter({ checks }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/ready', async (req, res) => {
    const entries = await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        try {
          await withTimeout(Promise.resolve().then(check), CHECK_TIMEOUT_MS);
          return [name, 'ok'];
        } catch (err) {
          req.log?.warn({ dependency: name, err: err.message }, 'readiness check failed');
          return [name, 'unavailable'];
        }
      }),
    );
    const dependencies = Object.fromEntries(entries);
    const ready = entries.every(([, state]) => state === 'ok');
    res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'degraded', dependencies });
  });

  return router;
}
