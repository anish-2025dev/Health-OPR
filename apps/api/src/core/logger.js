import pino from 'pino';

// Never log OTPs, passwords, tokens, bank details or full statutory identifiers.
// Add new sensitive field names here as modules are introduced.
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.otp',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.bankAccountNumber',
  '*.pan',
  '*.aadhaar',
  '*.uan',
];

export function createLogger(config) {
  return pino({
    level: config.APP_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: 'healthos-api', env: config.APP_ENV },
  });
}
