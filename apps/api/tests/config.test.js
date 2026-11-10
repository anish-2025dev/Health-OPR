import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';

describe('loadConfig', () => {
  it('applies development defaults', () => {
    const config = loadConfig({});
    expect(config.APP_ENV).toBe('development');
    expect(config.API_PORT).toBe(4000);
    expect(config.ACCESS_TOKEN_EXPIRE_MINUTES).toBe(15);
  });

  it('refuses to start production with a placeholder secret', () => {
    expect(() =>
      loadConfig({ APP_ENV: 'production', APP_SECRET_KEY: 'change-me-dev-only' }),
    ).toThrow(/APP_SECRET_KEY/);
  });

  it('refuses to start staging with a short secret', () => {
    expect(() => loadConfig({ APP_ENV: 'staging', APP_SECRET_KEY: 'short' })).toThrow(
      /APP_SECRET_KEY/,
    );
  });

  it('accepts production with a strong secret', () => {
    const config = loadConfig({ APP_ENV: 'production', APP_SECRET_KEY: 'x'.repeat(48) });
    expect(config.APP_ENV).toBe('production');
  });

  it('is immutable', () => {
    const config = loadConfig({});
    expect(Object.isFrozen(config)).toBe(true);
  });
});
