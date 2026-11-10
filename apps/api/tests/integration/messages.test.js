import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addUser, bearer, createTenant, login, setupTestApp, sys } from './helpers.js';

// Fictional people only.
const { app, db, sms } = setupTestApp();
let t;
let other;
let owner;
let hr;
let payrollUser;
let manager;
let workerA;
let workerB;
let outsider;
let reception;
const emp = {};

const api = (token) => ({
  get: (url) => request(app).get(`/api/v1${url}`).set(bearer(token)),
  post: (url, body = {}) => request(app).post(`/api/v1${url}`).set(bearer(token)).send(body),
});

/** Creates an employee linked to a login with the given roles. */
async function employeeWithLogin(label, mobile, roles = ['employee'], managerId = null) {
  const user = await addUser(db, t.organization.id, roles, label);
  const [e] = await sys(db, (x) =>
    x('employees')
      .insert({
        organization_id: t.organization.id,
        employee_number: `M-${label}`.toUpperCase().slice(0, 20),
        full_name: `Test ${label}`,
        mobile_e164: mobile,
        branch_id: t.branch.id,
        joining_date: '2025-01-01',
        user_id: user.id,
        reporting_manager_id: managerId,
      })
      .returning('*'),
  );
  return { employee: e, client: api((await login(app, user.email)).token) };
}

beforeAll(async () => {
  t = await createTenant(db, 'msg');
  other = await createTenant(db, 'msgb');
  owner = api((await login(app, t.owner.email)).token);
  hr = api(
    (await login(app, (await addUser(db, t.organization.id, ['hr_manager'], 'hr')).email)).token,
  );
  payrollUser = api(
    (await login(app, (await addUser(db, t.organization.id, ['payroll_manager'], 'pm')).email))
      .token,
  );
  reception = api(
    (await login(app, (await addUser(db, t.organization.id, ['receptionist'], 'rc')).email)).token,
  );
  const m = await employeeWithLogin('mgr', '+919844400001', ['department_manager']);
  manager = m.client;
  emp.manager = m.employee;
  const a = await employeeWithLogin('wa', '+919844400002', ['employee'], emp.manager.id);
  workerA = a.client;
  emp.a = a.employee;
  const b = await employeeWithLogin('wb', '+919844400003', ['employee'], emp.manager.id);
  workerB = b.client;
  emp.b = b.employee;
  const o = await employeeWithLogin('out', '+919844400004');
  outsider = o.client;
  emp.out = o.employee;
});
afterAll(() => db.destroy());

describe('sending', () => {
  it('HR can message everyone; employees see it unread in their inbox', async () => {
    const r = await hr.post('/messages', {
      category: 'general',
      title: 'Clinic closed on Friday',
      body: 'The clinic is closed this Friday for maintenance.',
      audience: { type: 'all' },
    });
    expect(r.status).toBe(201);
    expect(r.body.recipients).toBe(4);
    const inbox = await workerA.get('/me/messages');
    expect(inbox.body.unread).toBe(1);
    expect(inbox.body.data[0]).toMatchObject({ title: 'Clinic closed on Friday', readAt: null });
    await workerA.post(`/me/messages/${r.body.id}/read`);
    expect((await workerA.get('/me/messages')).body.unread).toBe(0);
  });

  it('managers message only their own team, and not about payroll', async () => {
    const ok = await manager.post('/messages', {
      category: 'performance',
      title: 'Great work this month',
      body: 'Thank you for covering the evening shifts.',
      audience: { type: 'employees', employeeIds: [emp.a.id] },
    });
    expect(ok.status).toBe(201);
    expect((await workerA.get('/me/messages')).body.data[0].title).toBe('Great work this month');
    // a private performance note is not visible to others
    expect((await workerB.get('/me/messages')).body.data.map((m) => m.title)).not.toContain(
      'Great work this month',
    );
    const team = await manager.post('/messages', {
      category: 'attendance',
      title: 'Shift change',
      body: 'Next week starts at 9.',
      audience: { type: 'team' },
    });
    expect(team.body.recipients).toBe(2);
    const notMine = await manager.post('/messages', {
      category: 'performance',
      title: 'Hello there',
      body: 'x',
      audience: { type: 'employees', employeeIds: [emp.out.id] },
    });
    expect(notMine.status).toBe(403);
    const all = await manager.post('/messages', {
      category: 'general',
      title: 'Hello all',
      body: 'x',
      audience: { type: 'all' },
    });
    expect(all.status).toBe(403);
    const pay = await manager.post('/messages', {
      category: 'payroll',
      title: 'Salary',
      body: 'x',
      audience: { type: 'team' },
    });
    expect(pay.status).toBe(403);
  });

  it('payroll staff send payroll messages only; others cannot send', async () => {
    const ok = await payrollUser.post('/messages', {
      category: 'payroll',
      title: 'Bank details',
      body: 'Please confirm your bank account with HR.',
      audience: { type: 'branch', branchId: t.branch.id },
    });
    expect(ok.status).toBe(201);
    const general = await payrollUser.post('/messages', {
      category: 'general',
      title: 'Party',
      body: 'x',
      audience: { type: 'all' },
    });
    expect(general.status).toBe(403);
    expect((await reception.get('/messages/options')).status).toBe(403);
    expect(
      (
        await workerA.post('/messages', {
          category: 'general',
          title: 'Hey you',
          body: 'x',
          audience: { type: 'all' },
        })
      ).status,
    ).toBe(403);
  });

  it('an SMS alert says only that a message is waiting', async () => {
    sms.sent.splice(0);
    const r = await hr.post('/messages', {
      category: 'leave',
      title: 'Leave policy updated',
      body: 'Confidential details inside the app.',
      audience: { type: 'employees', employeeIds: [emp.b.id] },
      smsAlert: true,
    });
    expect(r.status).toBe(201);
    const alert = sms.sent.find((m) => m.purpose === 'message_alert');
    expect(alert.to).toBe('+919844400003');
    expect(JSON.stringify(alert.variables)).not.toContain('Confidential');
  });

  it('senders see read counts; HR sees all sent messages', async () => {
    const mine = await manager.get('/messages/sent');
    expect(mine.body.data.every((m) => m.sender === 'Test mgr')).toBe(true);
    const everyone = await hr.get('/messages/sent');
    const first = everyone.body.data.find((m) => m.title === 'Clinic closed on Friday');
    expect(first).toMatchObject({ recipients: 4, read: 1 });
  });
});

describe('automatic payslip message', () => {
  it('approving payroll tells each employee their payslip is ready', async () => {
    const basic = (
      await owner.post('/payroll/components', { name: 'Basic', code: 'BASIC', kind: 'earning' })
    ).body;
    await owner.post('/payroll/structures', {
      employeeId: emp.a.id,
      effectiveFrom: '2026-01-01',
      lines: [{ componentId: basic.id, amount: '10000' }],
    });
    const run = (await owner.post('/payroll/runs', { month: '2026-10' })).body;
    await owner.post(`/payroll/runs/${run.id}/calculate`);
    const approved = await owner.post(`/payroll/runs/${run.id}/approve`, { confirm: true });
    expect(approved.status).toBe(200);
    const inbox = await workerA.get('/me/messages');
    expect(inbox.body.data[0]).toMatchObject({
      category: 'payroll',
      title: 'Your payslip for October 2026 is ready',
    });
    expect(inbox.body.data[0].body).not.toMatch(/\d{3,}/); // no amounts in the message
  });
});

describe('isolation', () => {
  it('other organizations see nothing', async () => {
    const o = api((await login(app, other.owner.email)).token);
    expect((await o.get('/messages/sent')).body.data).toEqual([]);
    const r = await o.post('/messages', {
      category: 'general',
      title: 'Cross tenant',
      body: 'x',
      audience: { type: 'employees', employeeIds: [emp.a.id] },
    });
    expect(r.status).toBe(403);
    expect((await outsider.get('/me/messages')).body.data.map((m) => m.title)).not.toContain(
      'Cross tenant',
    );
  });
});
