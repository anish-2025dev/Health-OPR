import { AppError } from './errors.js';

/** In-process store for tests and single-instance development. */
export function createMemoryStore() {
  const hits = new Map();
  return {
    async increment(key, windowSec) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowSec * 1000 });
        return 1;
      }
      entry.count += 1;
      return entry.count;
    },
  };
}

/** Redis fixed-window store shared by all API instances. */
export function createRedisStore(redis) {
  return {
    async increment(key, windowSec) {
      const results = await redis.multi().incr(key).expire(key, windowSec, 'NX').exec();
      return results[0][1];
    },
  };
}

/**
 * Express middleware limiting requests per key. If the store is unavailable it fails open and logs
 * a warning: login is still protected by the per-account lockout in the database.
 */
export function rateLimit({ store, prefix, limit, windowSec, key }) {
  return async (req, res, next) => {
    const id = `rl:${prefix}:${key(req)}`;
    let count;
    try {
      count = await store.increment(id, windowSec);
    } catch (err) {
      req.log?.warn({ err: err.message }, 'rate limiter unavailable; allowing request');
      return next();
    }
    if (count > limit) {
      res.set('Retry-After', String(windowSec));
      return next(new AppError(429, 'RATE_LIMITED', 'Too many attempts. Please try again later.'));
    }
    next();
  };
}
