import { Redis } from 'ioredis';

export function createRedis(config) {
  return new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  });
}
