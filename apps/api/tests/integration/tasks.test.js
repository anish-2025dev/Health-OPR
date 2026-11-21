import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addUser, bearer, createTenant, login, setupTestApp, sys } from './helpers.js';

const { app, db, sms } = setupTestApp();

let t;
let other;
let hr;
let manager;
let worker;
let workerToken;
let otherWorker;
let otherWorkerToken;

const api = (token) => ({
  get: (url) => request(app).get(`/api/v1${url}`).set(bearer(token)),
  post: (url, body = {}) => request(app).post(`/api/v1${url}`).set(bearer(token)).send(body),
  patch: (url, body = {}) => request(app).patch(`/api/v1${url}`).set(bearer(token)).send(body),
  delete: (url) => request(app).delete(`/api/v1${url}`).set(bearer(token)),
});

async function employeeToken(company, mobile) {
  await sys(db, (x) =>
    x('otp_challenges').update({ created_at: x.raw("created_at - interval '1 minute'") }),
  );
  await request(app).post('/api/v1/auth/employee/request-otp').send({ company, mobile });
  const res = await request(app)
    .post('/api/v1/auth/employee/verify-otp')
    .send({ company, mobile, code: sms.lastCodeFor(`+91${mobile}`) });
  return res.body.accessToken;
}

beforeAll(async () => {
  t = await createTenant(db, 'tsk');
  other = await createTenant(db, 'tskb');

  const hrUser = await addUser(db, t.organization.id, ['hr_manager'], 'hr');
  const hrLogin = await login(app, hrUser.email);
  hr = api(hrLogin.token);

  // Create manager and workers
  const mgrRes = await hr.post('/hr/employees', {
    fullName: 'Tim TeamLead',
    mobile: '9300000001',
    branchId: t.branch.id,
    joiningDate: '2026-01-01',
  });
  manager = mgrRes.body;

  const workerRes = await hr.post('/hr/employees', {
    fullName: 'Edward Employee',
    mobile: '9300000002',
    branchId: t.branch.id,
    joiningDate: '2026-01-01',
    reportingManagerId: manager.id,
  });
  worker = workerRes.body;
  workerToken = await employeeToken(t.organization.slug, '9300000002');

  // Other tenant worker
  const otherHrUser = await addUser(db, other.organization.id, ['hr_manager'], 'otherhr');
  const otherHr = api((await login(app, otherHrUser.email)).token);
  const otherWorkerRes = await otherHr.post('/hr/employees', {
    fullName: 'Oscar Other',
    mobile: '9300000003',
    branchId: other.branch.id,
    joiningDate: '2026-01-01',
  });
  otherWorker = otherWorkerRes.body;
  expect(otherWorker.id).toBeDefined();
  otherWorkerToken = await employeeToken(other.organization.slug, '9300000003');
});

afterAll(async () => {
  await db.destroy();
});

describe('Task Management Integration Tests (§4)', () => {
  let createdTaskId;

  it('HR can create and assign a task to an employee (§4.1)', async () => {
    const res = await hr.post('/tasks', {
      title: 'Prepare ICU Equipment Inventory',
      description: 'Check all ventilators and monitors in wing B',
      assignedToEmployeeId: worker.id,
      priority: 'high',
      startDate: '2026-11-20',
      deadline: '2026-11-25',
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.title).toBe('Prepare ICU Equipment Inventory');
    expect(res.body.priority).toBe('high');
    expect(res.body.status).toBe('pending');
    expect(res.body.assignedTo.id).toBe(worker.id);
    expect(res.body.assignedTo.fullName).toBe('Edward Employee');

    createdTaskId = res.body.id;
  });

  it('Employee sees the assigned task in their personal dashboard (/me/tasks) (§4.2)', async () => {
    const workerApi = api(workerToken);
    const res = await workerApi.get('/me/tasks');

    expect(res.status).toBe(200);
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.total).toBeGreaterThanOrEqual(1);
    expect(res.body.data.some((t) => t.id === createdTaskId)).toBe(true);
  });

  it('Employee can update task status and provide completion notes (§4.3)', async () => {
    const workerApi = api(workerToken);

    // Update to in_progress
    const inProgRes = await workerApi.patch(`/me/tasks/${createdTaskId}/status`, {
      status: 'in_progress',
    });
    expect(inProgRes.status).toBe(200);
    expect(inProgRes.body.status).toBe('in_progress');

    // Add a progress comment
    const commentRes = await workerApi.post(`/me/tasks/${createdTaskId}/comments`, {
      body: 'Started inspection of ventilators in Wing B',
    });
    expect(commentRes.status).toBe(201);
    expect(commentRes.body.body).toBe('Started inspection of ventilators in Wing B');

    // Complete the task
    const completeRes = await workerApi.patch(`/me/tasks/${createdTaskId}/status`, {
      status: 'completed',
      completionNotes: 'All 12 ventilators verified and operational',
    });
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.status).toBe('completed');
    expect(completeRes.body.completionNotes).toBe('All 12 ventilators verified and operational');
    expect(completeRes.body.completedAt).not.toBeNull();
  });

  it('Manager/HR can query task details with full comment history', async () => {
    const res = await hr.get(`/tasks/${createdTaskId}`);
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Prepare ICU Equipment Inventory');
    expect(res.body.comments).toHaveLength(1);
    expect(res.body.comments[0].body).toContain('Started inspection');
  });

  it('Task analytics provide task status and workload breakdown (§4.4, §11.3)', async () => {
    const res = await hr.get('/tasks/analytics');
    expect(res.status).toBe(200);
    expect(res.body.summary.completed).toBeGreaterThanOrEqual(1);
    expect(res.body.workloads.length).toBeGreaterThanOrEqual(1);
  });

  it('Enforces cross-tenant isolation: Tenant B cannot view or modify Tenant A tasks', async () => {
    const otherWorkerApi = api(otherWorkerToken);

    // Other tenant worker cannot view Tenant A task
    const getRes = await otherWorkerApi.get(`/tasks/${createdTaskId}`);
    expect(getRes.status).toBe(404);

    // Other tenant worker cannot update status
    const updateRes = await otherWorkerApi.patch(`/me/tasks/${createdTaskId}/status`, {
      status: 'pending',
    });
    expect(updateRes.status).toBe(404);
  });
});
