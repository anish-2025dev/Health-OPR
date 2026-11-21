import { describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { createLogger } from '../src/core/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function mockDb() {
  const queryBuilder = {
    select: () => queryBuilder,
    where: () => queryBuilder,
    first: () => Promise.resolve(null),
    insert: () => queryBuilder,
    returning: () => Promise.resolve([]),
    update: () => Promise.resolve(0),
    delete: () => Promise.resolve(0),
    transacting: () => queryBuilder,
  };
  const fn = () => queryBuilder;
  fn.raw = () => Promise.resolve({ rows: [] });
  fn.transaction = async (cb) => cb(fn);
  return fn;
}

describe('Health & Liveness Probes', () => {
  const config = loadConfig({ APP_ENV: 'test' });
  const logger = createLogger(config);
  const app = createApp({
    config,
    logger,
    checks: {
      postgres: async () => 'ok',
      redis: async () => 'PONG',
    },
    db: mockDb(),
  });

  it('GET /healthz returns 200 OK for ingress/edge liveness probe', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /api/v1/health returns 200 OK for standard liveness probe', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /api/v1/health/live returns 200 OK for k8s/cloud-native probe', async () => {
    const res = await request(app).get('/api/v1/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /api/v1/health/ready returns 200 OK with dependency status', async () => {
    const res = await request(app).get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.dependencies).toEqual({ postgres: 'ok', redis: 'ok' });
  });
});

describe('PRODUCT_MODE Route Scoping', () => {
  it('PRODUCT_MODE=mgt mounts Suntek-Mgt routes and excludes Suntek-ops routes', async () => {
    const mgtConfig = loadConfig({ APP_ENV: 'test', PRODUCT_MODE: 'mgt' });
    const logger = createLogger(mgtConfig);
    const app = createApp({
      config: mgtConfig,
      logger,
      checks: { postgres: async () => 'ok' },
      db: mockDb(),
    });

    // Suntek-Mgt domain routes mounted
    const mgtRes = await request(app).get('/api/v1/mgt/leave/types');
    expect(mgtRes.status).not.toBe(404);

    const mgtRootRes = await request(app).get('/api/v1/leave/types');
    expect(mgtRootRes.status).not.toBe(404);

    // Suntek-ops routes NOT mounted
    const opsRes = await request(app).get('/api/v1/ops/appointments');
    expect(opsRes.status).toBe(404);

    const opsRootRes = await request(app).get('/api/v1/appointments');
    expect(opsRootRes.status).toBe(404);
  });

  it('PRODUCT_MODE=ops mounts Suntek-ops routes and excludes Suntek-Mgt routes', async () => {
    const opsConfig = loadConfig({ APP_ENV: 'test', PRODUCT_MODE: 'ops' });
    const logger = createLogger(opsConfig);
    const app = createApp({
      config: opsConfig,
      logger,
      checks: { postgres: async () => 'ok' },
      db: mockDb(),
    });

    // Suntek-ops domain routes mounted
    const opsRes = await request(app).get('/api/v1/ops/appointments');
    expect(opsRes.status).not.toBe(404);

    const opsRootRes = await request(app).get('/api/v1/appointments');
    expect(opsRootRes.status).not.toBe(404);

    // Suntek-Mgt routes NOT mounted
    const mgtRes = await request(app).get('/api/v1/mgt/leave/types');
    expect(mgtRes.status).toBe(404);

    const mgtRootRes = await request(app).get('/api/v1/leave/types');
    expect(mgtRootRes.status).toBe(404);
  });

  it('PRODUCT_MODE=platform mounts Platform Console routes and excludes domain routes', async () => {
    const platformConfig = loadConfig({ APP_ENV: 'test', PRODUCT_MODE: 'platform' });
    const logger = createLogger(platformConfig);
    const app = createApp({
      config: platformConfig,
      logger,
      checks: { postgres: async () => 'ok' },
      db: mockDb(),
    });

    const pltRes = await request(app).get('/api/v1/platform/invite/test');
    expect(pltRes.status).not.toBe(404);

    const mgtRes = await request(app).get('/api/v1/mgt/leave/types');
    expect(mgtRes.status).toBe(404);

    const opsRes = await request(app).get('/api/v1/ops/appointments');
    expect(opsRes.status).toBe(404);
  });

  it('PRODUCT_MODE=all mounts all domain and root routes concurrently', async () => {
    const allConfig = loadConfig({ APP_ENV: 'test', PRODUCT_MODE: 'all' });
    const logger = createLogger(allConfig);
    const app = createApp({
      config: allConfig,
      logger,
      checks: { postgres: async () => 'ok' },
      db: mockDb(),
    });

    expect((await request(app).get('/api/v1/mgt/leave/types')).status).not.toBe(404);
    expect((await request(app).get('/api/v1/ops/appointments')).status).not.toBe(404);
    expect((await request(app).get('/api/v1/platform/invite/test')).status).not.toBe(404);
  });
});

describe('Multi-Origin CORS Integration', () => {
  const config = loadConfig({
    APP_ENV: 'test',
    FRONTEND_URL: 'http://localhost:5173',
    PATIENT_SITE_URL: 'http://localhost:5174',
    MGT_FRONTEND_URL: 'http://localhost:5175',
    OPS_FRONTEND_URL: 'http://localhost:5176',
    PLATFORM_CONSOLE_URL: 'http://localhost:5177',
  });
  const logger = createLogger(config);
  const app = createApp({
    config,
    logger,
    checks: { postgres: async () => 'ok' },
    db: mockDb(),
  });

  it('allows requests from MGT_FRONTEND_URL', async () => {
    const res = await request(app).get('/healthz').set('Origin', 'http://localhost:5175');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5175');
  });

  it('allows requests from OPS_FRONTEND_URL', async () => {
    const res = await request(app).get('/healthz').set('Origin', 'http://localhost:5176');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5176');
  });

  it('allows requests from PLATFORM_CONSOLE_URL', async () => {
    const res = await request(app).get('/healthz').set('Origin', 'http://localhost:5177');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5177');
  });

  it('rejects CORS headers for unauthorized origins', async () => {
    const res = await request(app).get('/healthz').set('Origin', 'http://malicious-site.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('Production Environment Validation', () => {
  const validProduction = {
    APP_ENV: 'production',
    APP_SECRET_KEY: 'x'.repeat(48),
    DATABASE_URL:
      'postgresql://app:pw@ep-xyz-pooler.ap-southeast-1.aws.neon.tech/healthos?sslmode=require',
    FRONTEND_URL: 'https://healthos-web.onrender.com',
    MGT_FRONTEND_URL: 'https://suntek-mgt-web.onrender.com',
    OPS_FRONTEND_URL: 'https://suntek-ops-web.onrender.com',
    PLATFORM_CONSOLE_URL: 'https://suntek-platform-web.onrender.com',
  };

  it('accepts valid production config with all decoupled frontend URLs', () => {
    const config = loadConfig(validProduction);
    expect(config.PRODUCT_MODE).toBe('all');
    expect(config.MGT_FRONTEND_URL).toBe('https://suntek-mgt-web.onrender.com');
  });

  it('validates PRODUCT_MODE enum', () => {
    expect(() => loadConfig({ ...validProduction, PRODUCT_MODE: 'invalid_mode' })).toThrow(
      /PRODUCT_MODE/,
    );
  });

  it('rejects non-https MGT_FRONTEND_URL in production', () => {
    expect(() =>
      loadConfig({ ...validProduction, MGT_FRONTEND_URL: 'http://insecure-mgt.com' }),
    ).toThrow(/MGT_FRONTEND_URL/);
  });

  it('rejects non-https OPS_FRONTEND_URL in production', () => {
    expect(() =>
      loadConfig({ ...validProduction, OPS_FRONTEND_URL: 'http://insecure-ops.com' }),
    ).toThrow(/OPS_FRONTEND_URL/);
  });

  it('rejects non-https PLATFORM_CONSOLE_URL in production', () => {
    expect(() =>
      loadConfig({ ...validProduction, PLATFORM_CONSOLE_URL: 'http://insecure-plt.com' }),
    ).toThrow(/PLATFORM_CONSOLE_URL/);
  });
});

describe('Blueprint Files Infrastructure as Code Integrity', () => {
  it('render.yaml contains all unified and decoupled service definitions', () => {
    const renderYamlPath = path.resolve(here, '../../../render.yaml');
    const content = fs.readFileSync(renderYamlPath, 'utf8');

    // Unified services
    expect(content).toContain('name: healthos-api');
    expect(content).toContain('name: healthos-web');
    expect(content).toContain('name: healthos-patient');
    expect(content).toContain('name: healthos-redis');

    // Decoupled services
    expect(content).toContain('name: suntek-mgt-api');
    expect(content).toContain('name: suntek-mgt-web');
    expect(content).toContain('name: suntek-ops-api');
    expect(content).toContain('name: suntek-ops-web');
    expect(content).toContain('name: suntek-platform-web');

    // Product modes and surfaces
    expect(content).toContain('value: mgt');
    expect(content).toContain('value: ops');
    expect(content).toContain('value: platform');
  });

  it('render.decoupled.yaml defines standalone decoupled topology', () => {
    const decoupledPath = path.resolve(here, '../../../render.decoupled.yaml');
    expect(fs.existsSync(decoupledPath)).toBe(true);

    const content = fs.readFileSync(decoupledPath, 'utf8');
    expect(content).toContain('name: suntek-mgt-api');
    expect(content).toContain('name: suntek-mgt-web');
    expect(content).toContain('name: suntek-ops-api');
    expect(content).toContain('name: suntek-ops-web');
    expect(content).toContain('name: suntek-patient-web');
    expect(content).toContain('name: suntek-platform-web');
    expect(content).toContain('name: suntek-redis');
  });
});
