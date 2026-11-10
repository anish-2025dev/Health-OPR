import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';

const NEON_URL =
  'postgresql://app_user:pw@ep-example-123456-pooler.ap-southeast-1.aws.neon.tech/healthos?sslmode=require';

const production = (overrides = {}) => ({
  APP_ENV: 'production',
  APP_SECRET_KEY: 'x'.repeat(48),
  DATABASE_URL: NEON_URL,
  FRONTEND_URL: 'https://healthos-web.onrender.com',
  PATIENT_SITE_URL: 'https://healthos-patient.onrender.com',
  ...overrides,
});

describe('loadConfig', () => {
  it('applies development defaults', () => {
    const config = loadConfig({});
    expect(config.APP_ENV).toBe('development');
    expect(config.API_PORT).toBe(4000);
    expect(config.ACCESS_TOKEN_EXPIRE_MINUTES).toBe(15);
  });

  it('is immutable', () => {
    expect(Object.isFrozen(loadConfig({}))).toBe(true);
  });

  it('prefers the platform-provided PORT over API_PORT', () => {
    expect(loadConfig({ PORT: '10000', API_PORT: '4000' }).API_PORT).toBe(10000);
    expect(loadConfig({ API_PORT: '4100' }).API_PORT).toBe(4100);
  });

  it('accepts a complete production configuration (Neon + Render)', () => {
    const config = loadConfig(production());
    expect(config.APP_ENV).toBe('production');
    expect(config.DATABASE_URL).toBe(NEON_URL);
  });

  it('refuses production with a placeholder secret', () => {
    expect(() => loadConfig(production({ APP_SECRET_KEY: 'change-me-dev-only' }))).toThrow(
      /APP_SECRET_KEY/,
    );
  });

  it('refuses staging with a short secret', () => {
    expect(() => loadConfig(production({ APP_ENV: 'staging', APP_SECRET_KEY: 'short' }))).toThrow(
      /APP_SECRET_KEY/,
    );
  });

  it('refuses production without TLS to the database', () => {
    const noSsl = NEON_URL.replace('?sslmode=require', '');
    expect(() => loadConfig(production({ DATABASE_URL: noSsl }))).toThrow(/DATABASE_URL.*TLS/);
    const disabled = NEON_URL.replace('require', 'disable');
    expect(() => loadConfig(production({ DATABASE_URL: disabled }))).toThrow(/DATABASE_URL/);
  });

  it('refuses production pointing at a local database', () => {
    expect(() =>
      loadConfig(production({ DATABASE_URL: 'postgres://u:p@localhost:5432/db?sslmode=require' })),
    ).toThrow(/DATABASE_URL.*local/);
  });

  it('refuses production with a non-https frontend origin', () => {
    expect(() => loadConfig(production({ FRONTEND_URL: 'http://localhost:5173' }))).toThrow(
      /FRONTEND_URL/,
    );
  });

  it('never echoes secret values in validation errors', () => {
    const secretUrl = 'postgres://user:SuperSecretPw@localhost/db';
    try {
      loadConfig(production({ DATABASE_URL: secretUrl, APP_SECRET_KEY: 'tiny-secret' }));
      expect.unreachable();
    } catch (err) {
      expect(err.message).not.toContain('SuperSecretPw');
      expect(err.message).not.toContain('tiny-secret');
    }
  });
});
