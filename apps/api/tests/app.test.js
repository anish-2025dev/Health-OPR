import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/core/logger.js';

const config = loadConfig({ APP_ENV: 'test' });
const logger = createLogger(config);

function buildApp(checks = { postgres: async () => {}, redis: async () => {} }) {
  return createApp({ config, logger, checks });
}

describe('health endpoints', () => {
  it('liveness returns ok without touching dependencies', async () => {
    const app = buildApp({
      postgres: () => Promise.reject(new Error('down')),
      redis: () => Promise.reject(new Error('down')),
    });
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('readiness returns 200 when all dependencies are reachable', async () => {
    const res = await request(buildApp()).get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', dependencies: { postgres: 'ok', redis: 'ok' } });
  });

  it('readiness returns 503 and hides error details when a dependency fails', async () => {
    const app = buildApp({
      postgres: async () => {},
      redis: () => Promise.reject(new Error('ECONNREFUSED 10.0.0.5:6379')),
    });
    const res = await request(app).get('/api/v1/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: 'degraded',
      dependencies: { postgres: 'ok', redis: 'unavailable' },
    });
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
  });
});

describe('error envelope', () => {
  it('unknown routes return a machine-readable 404 with a request id', async () => {
    const res = await request(buildApp()).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('malformed JSON returns INVALID_JSON instead of a stack trace', async () => {
    const res = await request(buildApp())
      .post('/api/v1/health')
      .set('content-type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
    expect(JSON.stringify(res.body)).not.toMatch(/at .+\.js/);
  });

  it('accepts a safe incoming request id and rejects an unsafe one', async () => {
    const safe = await request(buildApp()).get('/api/v1/health').set('x-request-id', 'abc-123');
    expect(safe.headers['x-request-id']).toBe('abc-123');
    const unsafe = await request(buildApp())
      .get('/api/v1/health')
      .set('x-request-id', '<script>alert(1)</script>');
    expect(unsafe.headers['x-request-id']).not.toContain('<script>');
  });
});

describe('security headers', () => {
  it('does not advertise the framework and sets helmet headers', async () => {
    const res = await request(buildApp()).get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
