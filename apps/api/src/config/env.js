import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
// Load the repository-root .env for local development. Real environments inject variables directly.
dotenv.config({ path: path.resolve(here, '../../../../.env'), quiet: true });

const PLACEHOLDER_SECRETS = new Set(['', 'change-me-dev-only']);

const schema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    APP_SECRET_KEY: z.string().default(''),
    API_PORT: z.coerce.number().int().positive().default(4000),
    FRONTEND_URL: z.string().url().default('http://localhost:5173'),
    ACCESS_TOKEN_EXPIRE_MINUTES: z.coerce.number().int().positive().default(15),
    REFRESH_TOKEN_EXPIRE_DAYS: z.coerce.number().int().positive().default(14),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.string().default('postgres://healthos@localhost:5432/healthos'),
    REDIS_URL: z.string().default('redis://localhost:6379/0'),
  })
  .superRefine((env, ctx) => {
    const deployed = env.APP_ENV === 'staging' || env.APP_ENV === 'production';
    if (
      deployed &&
      (PLACEHOLDER_SECRETS.has(env.APP_SECRET_KEY) || env.APP_SECRET_KEY.length < 32)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_SECRET_KEY'],
        message: 'must be a real secret of at least 32 characters in staging/production',
      });
    }
  });

export function loadConfig(source = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return Object.freeze(parsed.data);
}
