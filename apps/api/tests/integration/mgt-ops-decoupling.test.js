import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addUser, bearer, createTenant, login, setupTestApp } from './helpers.js';

const { app, db } = setupTestApp();

let t;
let hrApi;
let clinicApi;

const api = (token) => ({
  get: (url) => request(app).get(`/api/v1${url}`).set(bearer(token)),
  post: (url, body = {}) => request(app).post(`/api/v1${url}`).set(bearer(token)).send(body),
});

beforeAll(async () => {
  t = await createTenant(db, 'decouple');

  // HR Manager user (Mgt domain)
  const hrUser = await addUser(db, t.organization.id, ['hr_manager'], 'hrmgr');
  hrApi = api((await login(app, hrUser.email)).token);

  // Receptionist user (Ops domain)
  const recUser = await addUser(db, t.organization.id, ['receptionist'], 'reception');
  clinicApi = api((await login(app, recUser.email)).token);
});

afterAll(async () => {
  await db.destroy();
});

describe('Suntek Ecosystem — Domain Decoupling & Router Verification (Phase 2)', () => {
  describe('Suntek-Mgt Domain Routing', () => {
    it('accesses departments via /api/v1/mgt/departments and legacy /api/v1/departments', async () => {
      // 1. Post department via /api/v1/mgt/departments
      const createRes = await hrApi.post('/mgt/departments', {
        name: 'Decoupled Engineering',
        code: 'DENG',
      });
      expect(createRes.status).toBe(201);
      expect(createRes.body.name).toBe('Decoupled Engineering');

      // 2. Read via /api/v1/mgt/departments
      const getMgtRes = await hrApi.get('/mgt/departments');
      expect(getMgtRes.status).toBe(200);
      expect(getMgtRes.body.some((d) => d.code === 'DENG')).toBe(true);

      // 3. Read via legacy /api/v1/departments (backward compatibility)
      const getLegacyRes = await hrApi.get('/departments');
      expect(getLegacyRes.status).toBe(200);
      expect(getLegacyRes.body.some((d) => d.code === 'DENG')).toBe(true);
    });

    it('accesses employees via /api/v1/mgt/hr/employees and legacy /api/v1/hr/employees', async () => {
      const getMgtRes = await hrApi.get('/mgt/hr/employees');
      expect(getMgtRes.status).toBe(200);

      const getLegacyRes = await hrApi.get('/hr/employees');
      expect(getLegacyRes.status).toBe(200);
    });

    it('accesses tasks via /api/v1/mgt/tasks and legacy /api/v1/tasks', async () => {
      const getMgtRes = await hrApi.get('/mgt/tasks');
      expect(getMgtRes.status).toBe(200);

      const getLegacyRes = await hrApi.get('/tasks');
      expect(getLegacyRes.status).toBe(200);
    });
  });

  describe('Suntek-ops Domain Routing', () => {
    it('accesses patients via /api/v1/ops/patients and legacy /api/v1/patients', async () => {
      // 1. Create patient via /api/v1/ops/patients
      const createRes = await clinicApi.post('/ops/patients', {
        fullName: 'Diana Decoupled',
        mobileNumber: '+919876543299',
        yearOfBirth: 1990,
        gender: 'female',
      });
      expect(createRes.status).toBe(201);
      expect(createRes.body.fullName).toBe('Diana Decoupled');

      // 2. Read via /api/v1/ops/patients
      const getOpsRes = await clinicApi.get('/ops/patients?search=Diana');
      expect(getOpsRes.status).toBe(200);
      expect(getOpsRes.body.some((p) => p.fullName === 'Diana Decoupled')).toBe(true);

      // 3. Read via legacy /api/v1/patients
      const getLegacyRes = await clinicApi.get('/patients?search=Diana');
      expect(getLegacyRes.status).toBe(200);
      expect(getLegacyRes.body.some((p) => p.fullName === 'Diana Decoupled')).toBe(true);
    });

    it('accesses doctors via /api/v1/ops/doctors and legacy /api/v1/doctors', async () => {
      const getOpsRes = await clinicApi.get('/ops/doctors');
      expect(getOpsRes.status).toBe(200);

      const getLegacyRes = await clinicApi.get('/doctors');
      expect(getLegacyRes.status).toBe(200);
    });

    it('accesses queue via /api/v1/ops/queue and legacy /api/v1/queue', async () => {
      const getOpsRes = await clinicApi.get('/ops/queue');
      expect(getOpsRes.status).toBe(200);

      const getLegacyRes = await clinicApi.get('/queue');
      expect(getLegacyRes.status).toBe(200);
    });
  });

  describe('Domain Boundary & RBAC Permissions Isolation', () => {
    it('prevents clinical staff from accessing HRMS employee, claims, or payroll records', async () => {
      // Receptionist attempting to read HR employees
      const empRes = await clinicApi.get('/mgt/hr/employees');
      expect(empRes.status).toBe(403);
      expect(empRes.body.code).toBe('FORBIDDEN');

      // Receptionist attempting to read HR claims
      const claimsRes = await clinicApi.get('/mgt/hr/claims');
      expect(claimsRes.status).toBe(403);
      expect(claimsRes.body.code).toBe('FORBIDDEN');

      // Receptionist attempting to read payroll
      const payrollRes = await clinicApi.get('/mgt/payroll/runs');
      expect(payrollRes.status).toBe(403);
      expect(payrollRes.body.code).toBe('FORBIDDEN');
    });

    it('prevents HR personnel from accessing clinical patient directory and queues', async () => {
      // HR Manager attempting to read patients
      const patientRes = await hrApi.get('/ops/patients');
      expect(patientRes.status).toBe(403);
      expect(patientRes.body.code).toBe('FORBIDDEN');

      // HR Manager attempting to access clinical queue
      const queueRes = await hrApi.get('/ops/queue');
      expect(queueRes.status).toBe(403);
      expect(queueRes.body.code).toBe('FORBIDDEN');
    });

    it('protects /platform from tenant staff tokens', async () => {
      const platformRes = await hrApi.get('/platform/organizations');
      expect(platformRes.status).toBe(401);
    });
  });
});
