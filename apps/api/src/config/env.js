import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
// Load the repository-root .env for local development. Real environments inject variables directly.
dotenv.config({ path: path.resolve(here, '../../../../.env'), quiet: true });

const PLACEHOLDER_SECRETS = new Set(['', 'change-me-dev-only']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);
const INSECURE_SSLMODES = new Set(['disable', 'allow', 'prefer', 'no-verify']);

function databaseUrlIssue(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'must be a valid postgres:// connection string';
  }
  if (LOCAL_HOSTS.has(parsed.hostname))
    return 'must not point at a local database in staging/production';
  const sslmode = parsed.searchParams.get('sslmode');
  if (!sslmode || INSECURE_SSLMODES.has(sslmode)) {
    return 'must require TLS in staging/production (add ?sslmode=require or verify-full)';
  }
  return null;
}

const schema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    APP_SECRET_KEY: z.string().default(''),
    // Render (and most PaaS hosts) inject PORT; API_PORT is the local-development name.
    PORT: z.coerce.number().int().positive().optional(),
    API_PORT: z.coerce.number().int().positive().default(4000),
    FRONTEND_URL: z.string().url().default('http://localhost:5173'),
    // Patient website (separate deployment). Used for CORS and for links sent to patients.
    PATIENT_SITE_URL: z.string().url().default('http://localhost:5174'),
    PATIENT_SESSION_DAYS: z.coerce.number().int().min(1).max(180).default(30),
    ACCESS_TOKEN_EXPIRE_MINUTES: z.coerce.number().int().positive().default(15),
    REFRESH_TOKEN_EXPIRE_DAYS: z.coerce.number().int().positive().default(14),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.string().default('postgres://healthos@localhost:5432/healthos'),
    REDIS_URL: z.string().default('redis://localhost:6379/0'),
    // SMS for employee OTPs: 'msg91' in deployed environments, 'console' for local development.
    SMS_PROVIDER: z.enum(['msg91', 'console', '']).default(''),
    MSG91_AUTH_KEY: z.string().default(''),
    MSG91_OTP_TEMPLATE_ID: z.string().default(''),
    MSG91_OTP_VARIABLE: z
      .string()
      .regex(/^[A-Za-z0-9_]{1,30}$/)
      .default('otp'),
    // Optional SMS for appointment confirmations (fallback when WhatsApp isn't allowed). A separate
    // DLT-approved MSG91 template; its variable names, in order: token, date, time, link.
    MSG91_APPOINTMENT_TEMPLATE_ID: z.string().default(''),
    MSG91_APPOINTMENT_VARIABLES: z
      .string()
      .regex(/^[A-Za-z0-9_]{1,30}(,[A-Za-z0-9_]{1,30}){3}$/)
      .default('token,date,time,link'),
    // WhatsApp Business Platform (Meta Cloud API). 'console' prints messages in development.
    // Each hospital's WhatsApp phone number ID is registered in the app (Settings → WhatsApp).
    WHATSAPP_PROVIDER: z.enum(['meta', 'console', '']).default(''),
    WHATSAPP_ACCESS_TOKEN: z.string().default(''),
    WHATSAPP_APP_SECRET: z.string().default(''), // verifies webhook signatures
    WHATSAPP_VERIFY_TOKEN: z.string().default(''), // webhook subscription handshake
    // Graph API version shown in your Meta app dashboard, e.g. v21.0. Required for 'meta'.
    WHATSAPP_GRAPH_API_VERSION: z
      .string()
      .regex(/^(v\d+\.\d+)?$/)
      .default(''),
    // Name and language of the approved template used for appointment confirmations. Its body must
    // take four parameters, in order: token, date, time, link.
    WHATSAPP_APPOINTMENT_TEMPLATE: z.string().default(''),
    WHATSAPP_TEMPLATE_LANGUAGE: z.string().default('en'),
  })
  .superRefine((env, ctx) => {
    const deployed = env.APP_ENV === 'staging' || env.APP_ENV === 'production';
    if (!deployed) return;

    if (PLACEHOLDER_SECRETS.has(env.APP_SECRET_KEY) || env.APP_SECRET_KEY.length < 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_SECRET_KEY'],
        message: 'must be a real secret of at least 32 characters in staging/production',
      });
    }

    const dbIssue = databaseUrlIssue(env.DATABASE_URL);
    if (dbIssue) ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: dbIssue });

    if (!env.FRONTEND_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['FRONTEND_URL'],
        message: 'must be the https:// URL of the deployed web app in staging/production',
      });
    }
    if (!env.PATIENT_SITE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['PATIENT_SITE_URL'],
        message: 'must be the https:// URL of the deployed patient website in staging/production',
      });
    }
  })
  .transform(({ PORT, ...env }) => ({ ...env, API_PORT: PORT ?? env.API_PORT }));

export function loadConfig(source = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // Report which variables are wrong, never their values (they may be secrets).
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return Object.freeze(parsed.data);
}
