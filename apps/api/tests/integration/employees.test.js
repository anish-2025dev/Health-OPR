import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { withTenant } from '../../src/core/db.js';
import { addUser, bearer, createTenant, login, setupTestApp, sys } from './helpers.js';

const { app, db } = setupTestApp();
let a; // tenant A
let b; // tenant B
let hr;
let payroll;
let receptionist;
let employeeRole;
let tokenB;
let secondBranch;
let scopedHr;

const api = (token) => ({
  get: (url) => request(app).get(`/api/v1${url}`).set(bearer(token)),
  post: (url, body) => request(app).post(`/api/v1${url}`).set(bearer(token)).send(body),
  patch: (url, body) => request(app).patch(`/api/v1${url}`).set(bearer(token)).send(body),
  del: (url) => request(app).delete(`/api/v1${url}`).set(bearer(token)),
});

let mobileCounter = 0;
const nextMobile = () => `98${String(10_000_000 + mobileCounter++).slice(-8)}`;

const newEmployee = (overrides = {}) => ({
  fullName: 'Test Employee',
  mobile: nextMobile(),
  branchId: a.branch.id,
  joiningDate: '2026-01-15',
  ...overrides,
});

beforeAll(async () => {
  a = await createTenant(db, 'empa');
  b = await createTenant(db, 'empb');
  const hrUser = await addUser(db, a.organization.id, ['hr_manager'], 'hr');
  const payrollUser = await addUser(db, a.organization.id, ['payroll_manager'], 'payroll');
  const recUser = await addUser(db, a.organization.id, ['receptionist'], 'rec');
  const empUser = await addUser(db, a.organization.id, ['employee'], 'emp');
  hr = api((await login(app, hrUser.email)).token);
  payroll = api((await login(app, payrollUser.email)).token);
  receptionist = api((await login(app, recUser.email)).token);
  employeeRole = api((await login(app, empUser.email)).token);
  tokenB = api((await login(app, b.owner.email)).token);

  secondBranch = (await hr.get('/branches')).body.data[0]; // placeholder, replaced below
  const owner = api((await login(app, a.owner.email)).token);
  secondBranch = (await owner.post('/branches', { name: 'Second', code: 'SEC' })).body;
  const scoped = await addUser(
    db,
    a.organization.id,
    [{ role: 'hr_manager', branchId: secondBranch.id }],
    'scopedhr',
  );
  scopedHr = api((await login(app, scoped.email)).token);
});
afterAll(() => db.destroy());

describe('organization structure', () => {
  it('HR manages departments and designations; duplicate names are rejected', async () => {
    const dep = await hr.post('/departments', { name: 'Nursing' });
    expect(dep.status).toBe(201);
    expect((await hr.post('/departments', { name: 'nursing' })).status).toBe(409);
    const des = await hr.post('/designations', { name: 'Staff Nurse' });
    expect(des.status).toBe(201);
    const renamed = await hr.patch(`/departments/${dep.body.id}`, { name: 'Nursing Services' });
    expect(renamed.body.name).toBe('Nursing Services');
    const list = await payroll.get('/departments');
    expect(list.status).toBe(200);
    expect(list.body.data.map((d) => d.name)).toContain('Nursing Services');
  });

  it('shifts compute overnight and working minutes', async () => {
    const day = await hr.post('/shifts', {
      name: 'Day',
      startTime: '09:00',
      endTime: '18:00',
      breakMinutes: 60,
    });
    expect(day.body).toMatchObject({ overnight: false, workMinutes: 480 });
    const night = await hr.post('/shifts', { name: 'Night', startTime: '21:00', endTime: '07:00' });
    expect(night.body).toMatchObject({ overnight: true, workMinutes: 600 });
    const bad = await hr.post('/shifts', { name: 'Bad', startTime: '25:00', endTime: '07:00' });
    expect(bad.status).toBe(400);
  });

  it('holidays: organization-wide and per branch, readable by every role', async () => {
    const all = await hr.post('/holidays', { date: '2026-08-15', name: 'Independence Day' });
    expect(all.status).toBe(201);
    expect(all.body.date).toBe('2026-08-15'); // plain date string, no timezone shift
    await hr.post('/holidays', {
      date: '2026-09-01',
      name: 'Local festival',
      branchId: secondBranch.id,
    });
    expect((await hr.post('/holidays', { date: '2026-08-15', name: 'Dup' })).status).toBe(409);

    const forMain = await employeeRole.get(`/holidays?year=2026&branchId=${a.branch.id}`);
    expect(forMain.status).toBe(200);
    expect(forMain.body.data.map((h) => h.name)).toEqual(['Independence Day']);
    const forSecond = await employeeRole.get(`/holidays?year=2026&branchId=${secondBranch.id}`);
    expect(forSecond.body.data.map((h) => h.name)).toEqual(['Independence Day', 'Local festival']);

    expect(
      (await receptionist.post('/holidays', { date: '2026-10-02', name: 'X Day' })).status,
    ).toBe(403);
    expect((await hr.del(`/holidays/${all.body.id}`)).status).toBe(204);
  });
});

describe('employees', () => {
  it('auto-generates employee IDs and normalizes Indian mobile numbers', async () => {
    const first = await hr.post(
      '/hr/employees',
      newEmployee({ fullName: 'Asha Rao', mobile: '98765 43210' }),
    );
    expect(first.status).toBe(201);
    expect(first.body.employeeNumber).toMatch(/^EMP-\d{4}$/);
    expect(first.body.mobile).toBe('+919876543210');
    expect(first.body.joiningDate).toBe('2026-01-15');
    expect(first.body.weeklyOffDays).toEqual([0]);

    const second = await hr.post('/hr/employees', newEmployee({ fullName: 'Ravi Kumar' }));
    const n1 = Number(first.body.employeeNumber.slice(4));
    expect(Number(second.body.employeeNumber.slice(4))).toBe(n1 + 1);

    const dupMobile = await hr.post('/hr/employees', newEmployee({ mobile: '+91 98765-43210' }));
    expect(dupMobile.status).toBe(409);
    expect(dupMobile.body.error.code).toBe('MOBILE_TAKEN');

    const custom = await hr.post('/hr/employees', newEmployee({ employeeNumber: 'DOC-7' }));
    expect(custom.body.employeeNumber).toBe('DOC-7');
    const dupNumber = await hr.post('/hr/employees', newEmployee({ employeeNumber: 'DOC-7' }));
    expect(dupNumber.body.error.code).toBe('EMPLOYEE_NUMBER_TAKEN');

    const badMobile = await hr.post('/hr/employees', newEmployee({ mobile: '12345' }));
    expect(badMobile.status).toBe(400);
  });

  it('links department, designation, shift and reporting manager, and blocks reporting loops', async () => {
    const dep = (await hr.post('/departments', { name: 'Front Office' })).body;
    const shift = (await hr.get('/shifts')).body.data[0];
    const manager = (await hr.post('/hr/employees', newEmployee({ fullName: 'Manager One' }))).body;
    const report = (
      await hr.post(
        '/hr/employees',
        newEmployee({
          fullName: 'Report One',
          departmentId: dep.id,
          shiftId: shift.id,
          reportingManagerId: manager.id,
          weeklyOffDays: [6, 0, 0],
        }),
      )
    ).body;
    expect(report.department.name).toBe('Front Office');
    expect(report.reportingManager.name).toBe('Manager One');
    expect(report.weeklyOffDays).toEqual([0, 6]);

    const loop = await hr.patch(`/hr/employees/${manager.id}`, { reportingManagerId: report.id });
    expect(loop.status).toBe(400);
    expect(loop.body.error.code).toBe('REPORTING_CYCLE');
    const self = await hr.patch(`/hr/employees/${manager.id}`, { reportingManagerId: manager.id });
    expect(self.status).toBe(400);

    await hr.patch(`/departments/${dep.id}`, { status: 'inactive' });
    const inactiveDep = await hr.post('/hr/employees', newEmployee({ departmentId: dep.id }));
    expect(inactiveDep.status).toBe(400);
  });

  it('requires an exit date to mark an employee exited, and audits the change', async () => {
    const emp = (await hr.post('/hr/employees', newEmployee({ fullName: 'Leaving Soon' }))).body;
    expect((await hr.patch(`/hr/employees/${emp.id}`, { employmentStatus: 'exited' })).status).toBe(
      400,
    );
    const early = await hr.patch(`/hr/employees/${emp.id}`, {
      employmentStatus: 'exited',
      exitDate: '2025-01-01',
    });
    expect(early.status).toBe(400);
    const ok = await hr.patch(`/hr/employees/${emp.id}`, {
      employmentStatus: 'exited',
      exitDate: '2026-06-30',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.employmentStatus).toBe('exited');
    const audit = await sys(db, (t) =>
      t('audit_logs').where({ entity_id: emp.id, action: 'employee.status_exited' }).first(),
    );
    expect(audit.metadata.fields).toEqual(['employmentStatus', 'exitDate']);
  });

  it('searches by name or employee ID and filters by status', async () => {
    const res = await hr.get('/hr/employees?q=asha');
    expect(res.body.data.map((e) => e.fullName)).toEqual(['Asha Rao']);
    const exited = await hr.get('/hr/employees?status=exited');
    expect(exited.body.data.every((e) => e.employmentStatus === 'exited')).toBe(true);
    const wildcard = await hr.get('/hr/employees?q=%25');
    expect(wildcard.body.total).toBe(0);
  });
});

describe('employee permissions and privacy', () => {
  it('receptionists and employees cannot see employee records', async () => {
    expect((await receptionist.get('/hr/employees')).status).toBe(403);
    expect((await employeeRole.get('/hr/employees')).status).toBe(403);
    expect((await receptionist.get('/departments')).status).toBe(403);
  });

  it('payroll can read employees but sees masked mobiles and no emergency contacts, and cannot edit', async () => {
    const res = await payroll.get('/hr/employees?q=asha');
    expect(res.status).toBe(200);
    expect(res.body.data[0].mobile).toBe('+91 ••••••3210');
    expect(res.body.data[0].emergencyContact).toBeUndefined();
    expect((await payroll.post('/hr/employees', newEmployee())).status).toBe(403);
  });

  it('branch-scoped HR only sees and manages its own branch', async () => {
    const inScope = await scopedHr.post(
      '/hr/employees',
      newEmployee({ branchId: secondBranch.id, fullName: 'Second Branch' }),
    );
    expect(inScope.status).toBe(201);
    const outOfScope = await scopedHr.post('/hr/employees', newEmployee({ branchId: a.branch.id }));
    expect(outOfScope.status).toBe(400);

    const list = await scopedHr.get('/hr/employees');
    expect(list.body.data.every((e) => e.branch.id === secondBranch.id)).toBe(true);
    const mainEmployee = (await hr.get('/hr/employees?q=asha')).body.data[0];
    expect((await scopedHr.get(`/hr/employees/${mainEmployee.id}`)).status).toBe(404);
    expect(
      (await scopedHr.patch(`/hr/employees/${mainEmployee.id}`, { fullName: 'Xavier' })).status,
    ).toBe(404);
  });
});

describe('tenant isolation for employees and structure', () => {
  it("tenant B cannot see, read or edit tenant A's employees", async () => {
    const aEmployee = (await hr.get('/hr/employees?q=asha')).body.data[0];
    const list = await tokenB.get('/hr/employees');
    expect(list.body.data.map((e) => e.id)).not.toContain(aEmployee.id);
    expect((await tokenB.get(`/hr/employees/${aEmployee.id}`)).status).toBe(404);
    expect(
      (await tokenB.patch(`/hr/employees/${aEmployee.id}`, { fullName: 'Hijack' })).status,
    ).toBe(404);
  });

  it("tenant B cannot attach tenant A's department, manager or branch", async () => {
    const aDep = (await hr.get('/departments')).body.data[0];
    const aEmployee = (await hr.get('/hr/employees?q=asha')).body.data[0];
    const base = {
      fullName: 'B Person',
      mobile: nextMobile(),
      branchId: b.branch.id,
      joiningDate: '2026-02-01',
    };
    expect((await tokenB.post('/hr/employees', { ...base, departmentId: aDep.id })).status).toBe(
      400,
    );
    expect(
      (await tokenB.post('/hr/employees', { ...base, reportingManagerId: aEmployee.id })).status,
    ).toBe(400);
    expect((await tokenB.post('/hr/employees', { ...base, branchId: a.branch.id })).status).toBe(
      400,
    );
  });

  it('the same mobile number can exist in two different organizations', async () => {
    const res = await tokenB.post('/hr/employees', {
      fullName: 'Same Phone',
      mobile: '9876543210',
      branchId: b.branch.id,
      joiningDate: '2026-02-01',
    });
    expect(res.status).toBe(201);
  });

  it('RLS hides tenant A employees from a tenant B transaction', async () => {
    const rows = await withTenant(db, b.organization.id, (trx) =>
      trx('employees').select('organization_id'),
    );
    expect(rows.every((r) => r.organization_id === b.organization.id)).toBe(true);
    const holidays = await withTenant(db, b.organization.id, (trx) => trx('holidays').select('id'));
    expect(holidays).toEqual([]);
  });
});

describe('branch geofence settings', () => {
  it('stores a location and radius and validates them', async () => {
    const owner = api((await login(app, a.owner.email)).token);
    const ok = await owner.patch(`/branches/${a.branch.id}`, {
      location: { latitude: 12.971599, longitude: 77.594566 },
      geofenceRadiusM: 10,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.location).toEqual({ latitude: 12.971599, longitude: 77.594566 });
    expect(ok.body.geofenceRadiusM).toBe(10);

    expect((await owner.patch(`/branches/${a.branch.id}`, { geofenceRadiusM: 2 })).status).toBe(
      400,
    );
    const badLat = await owner.patch(`/branches/${a.branch.id}`, {
      location: { latitude: 120, longitude: 1 },
    });
    expect(badLat.status).toBe(400);
    const halfLocation = await owner.patch(`/branches/${a.branch.id}`, {
      location: { latitude: 12 },
    });
    expect(halfLocation.status).toBe(400);
  });
});
