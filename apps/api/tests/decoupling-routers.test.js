import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMgtRouter } from '../src/modules/mgt.routes.js';
import { createOpsRouter } from '../src/modules/ops.routes.js';
import { createPlatformDomainRouter } from '../src/modules/platform.routes.js';
import { apiV1Router } from '../src/api/v1/index.js';
import { loadConfig } from '../src/config/env.js';

describe('Suntek Ecosystem — Router Decoupling (Phase 2 Unit Tests)', () => {
  const config = loadConfig({ APP_ENV: 'test' });
  const mockDb = vi.fn();
  mockDb.raw = vi.fn().mockResolvedValue([]);

  const authenticate = (req, res, next) => {
    req.auth = {
      organizationId: '00000000-0000-0000-0000-000000000001',
      userId: '00000000-0000-0000-0000-000000000002',
      roles: ['organization_owner'],
      permissions: new Set(['organization.manage', 'employees.read', 'appointments.read']),
      branchIds: null,
    };
    next();
  };

  it('instantiates Suntek-Mgt router and mounts all HRMS subroutes', async () => {
    const app = express();
    const mgtRouter = createMgtRouter({
      db: mockDb,
      config,
      authenticate,
      smsSender: {},
      otp: {},
      logger: { info: vi.fn(), error: vi.fn() },
    });
    expect(mgtRouter).toBeDefined();
    app.use('/mgt', mgtRouter);

    // Verifying subroutes are reachable (not 404 Route Not Found)
    const depRes = await request(app).get('/mgt/departments');
    expect(depRes.status).not.toBe(404);

    const tasksRes = await request(app).get('/mgt/tasks');
    expect(tasksRes.status).not.toBe(404);

    const empRes = await request(app).get('/mgt/hr/employees');
    expect(empRes.status).not.toBe(404);

    const leaveRes = await request(app).get('/mgt/leave/types');
    expect(leaveRes.status).not.toBe(404);
  });

  it('instantiates Suntek-ops router and mounts all Hospital Ops subroutes', async () => {
    const app = express();
    const opsRouter = createOpsRouter({
      db: mockDb,
      config,
      authenticate,
      limiterStore: {},
      whatsappProcessor: {},
      whatsappSender: {},
      notifier: {},
      smsSender: {},
      logger: { info: vi.fn(), error: vi.fn() },
    });
    expect(opsRouter).toBeDefined();
    app.use('/ops', opsRouter);

    // Verifying subroutes are reachable (not 404 Route Not Found)
    const docRes = await request(app).get('/ops/doctors');
    expect(docRes.status).not.toBe(404);

    const apptRes = await request(app).get('/ops/appointments');
    expect(apptRes.status).not.toBe(404);

    const queueRes = await request(app).get('/ops/queue');
    expect(queueRes.status).not.toBe(404);

    const patientsRes = await request(app).get('/ops/patients');
    expect(patientsRes.status).not.toBe(404);
  });

  it('instantiates Platform Domain router with operator control plane', () => {
    const platformRouter = createPlatformDomainRouter({
      db: mockDb,
      config,
      rateLimitStore: {},
    });
    expect(platformRouter).toBeDefined();
  });

  it('mounts domain prefix routes and root backward-compatible routes in apiV1Router', async () => {
    const app = express();
    const router = apiV1Router({
      app,
      config,
      db: mockDb,
      logger: { info: vi.fn(), error: vi.fn() },
    });
    app.use('/api/v1', router);

    // 1. Verify health endpoint
    const healthRes = await request(app).get('/api/v1/health');
    expect(healthRes.status).toBe(200);

    // 2. Verify /api/v1/mgt/departments requires auth (returns 401 without token)
    const mgtRes = await request(app).get('/api/v1/mgt/departments');
    expect(mgtRes.status).toBe(401);

    // 3. Verify /api/v1/ops/patients requires auth (returns 401 without token)
    const opsRes = await request(app).get('/api/v1/ops/patients');
    expect(opsRes.status).toBe(401);

    // 4. Verify /api/v1/platform/auth/me returns 401 without platform token
    const platformRes = await request(app).get('/api/v1/platform/auth/me');
    expect(platformRes.status).toBe(401);

    // 5. Verify backward-compatible root mount /api/v1/departments also returns 401
    const legacyRes = await request(app).get('/api/v1/departments');
    expect(legacyRes.status).toBe(401);

    // 6. Verify backward-compatible root mount /api/v1/patients also returns 401
    const legacyPatRes = await request(app).get('/api/v1/patients');
    expect(legacyPatRes.status).toBe(401);
  });
});
