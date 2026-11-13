import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addUser, bearer, createTenant, login, setupTestApp, sys } from './helpers.js';

// Fictional people only.
const { app, db } = setupTestApp();
let t;
let other;
let hr;
let reception;

const api = (token) => ({
  get: (url) => request(app).get(`/api/v1${url}`).set(bearer(token)),
  post: (url, body = {}) => request(app).post(`/api/v1${url}`).set(bearer(token)).send(body),
});

const ROWS = [
  {
    'Employee ID': 'IMP-1',
    'Full Name': 'Meena Import',
    Mobile: '9877700001',
    Branch: 'MAIN',
    'Joining Date': '01-04-2024',
    Department: 'Nursing',
    Designation: 'Head Nurse',
    'Weekly Off': 'Sun',
  },
  {
    'Employee ID': 'IMP-2',
    'Full Name': 'Ravi Import',
    Mobile: '98777 00002',
    Branch: 'main',
    'Joining Date': '2025-01-15',
    Department: 'nursing',
    'Reports To': 'IMP-1',
    'Weekly Off': 'Sat, Sun',
    'Employment Type': 'Part time',
  },
  {
    'Full Name': 'Sara Import',
    Mobile: '+919877700003',
    Branch: 'Main',
    'Joining Date': '15/6/2025',
    'Reports To': '9877700001',
  },
];

beforeAll(async () => {
  t = await createTenant(db, 'imp');
  other = await createTenant(db, 'impb');
  hr = api(
    (await login(app, (await addUser(db, t.organization.id, ['hr_manager'], 'hr')).email)).token,
  );
  reception = api(
    (await login(app, (await addUser(db, t.organization.id, ['receptionist'], 'rc')).email)).token,
  );
});
afterAll(() => db.destroy());

describe('bulk employee upload', () => {
  it('only HR can upload', async () => {
    expect((await reception.post('/hr/employees/import', { rows: ROWS })).status).toBe(403);
  });

  it('previews every row and lists the problems without saving anything', async () => {
    const bad = [
      ...ROWS,
      {
        'Full Name': 'X',
        Mobile: '12345',
        Branch: 'Nowhere',
        'Joining Date': '31-02-2025',
        'Reports To': 'NOBODY',
        'Weekly Off': 'Funday',
      },
      {
        'Full Name': 'Dup Mobile',
        Mobile: '9877700001',
        Branch: 'MAIN',
        'Joining Date': '01-01-2025',
      },
    ];
    const r = await hr.post('/hr/employees/import', { rows: bad, dryRun: true });
    expect(r.status).toBe(200);
    // rows 2 and 3 name a department that does not exist yet; rows 5 and 6 are invalid
    expect(r.body.errorCount).toBe(4);
    const row5 = r.body.rows.find((x) => x.line === 5);
    expect(row5.errors.join(' | ')).toMatch(
      /not a valid mobile.*branch "Nowhere" not found.*joining date.*weekly off.*reports to "NOBODY"/,
    );
    expect(r.body.rows.find((x) => x.line === 6).errors).toContain('mobile repeats row 2');
    const saved = await sys(db, (x) =>
      x('employees').where({ organization_id: t.organization.id }).count({ n: '*' }).first(),
    );
    expect(Number(saved.n)).toBe(0);
  });

  it('refuses to import a file with errors; imports a clean file in one go', async () => {
    const refused = await hr.post('/hr/employees/import', { rows: ROWS, dryRun: false });
    expect(refused.status).toBe(400);
    expect(refused.body.rows[0].errors).toContain('department "Nursing" not found');
    const ok = await hr.post('/hr/employees/import', {
      rows: ROWS,
      dryRun: false,
      createMissing: true,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ imported: 3, created: { departments: 1, designations: 1 } });
    const list = (await hr.get('/hr/employees?limit=50')).body.data;
    const ravi = list.find((e) => e.fullName === 'Ravi Import');
    const sara = list.find((e) => e.fullName === 'Sara Import');
    expect(ravi).toMatchObject({
      employeeNumber: 'IMP-2',
      mobile: '+919877700002',
      employmentType: 'part_time',
      weeklyOffDays: [0, 6],
      joiningDate: '2025-01-15',
    });
    expect(ravi.reportingManager.employeeNumber).toBe('IMP-1');
    expect(ravi.department.name).toBe('Nursing');
    expect(sara.reportingManager.employeeNumber).toBe('IMP-1');
    expect(sara.employeeNumber).toMatch(/^EMP-\d{4}$/);
    expect(sara.joiningDate).toBe('2025-06-15');
  });

  it('catches reporting loops and existing duplicates', async () => {
    const loop = [
      {
        'Employee ID': 'L-1',
        'Full Name': 'Loop One',
        Mobile: '9877700011',
        Branch: 'MAIN',
        'Joining Date': '01-01-2025',
        'Reports To': 'L-2',
      },
      {
        'Employee ID': 'L-2',
        'Full Name': 'Loop Two',
        Mobile: '9877700012',
        Branch: 'MAIN',
        'Joining Date': '01-01-2025',
        'Reports To': 'L-1',
      },
      {
        'Employee ID': 'IMP-1',
        'Full Name': 'Again',
        Mobile: '9877700013',
        Branch: 'MAIN',
        'Joining Date': '01-01-2025',
      },
    ];
    const r = await hr.post('/hr/employees/import', { rows: loop });
    expect(r.body.rows[0].errors).toContain('reporting lines in the file form a loop');
    expect(r.body.rows[2].errors).toContain('employee ID IMP-1 already exists');
  });

  it('is isolated per organization', async () => {
    const o = api((await login(app, other.owner.email)).token);
    // the other hospital's manager references and branches are not visible here
    const r = await o.post('/hr/employees/import', {
      rows: [
        {
          'Full Name': 'Cross Tenant',
          Mobile: '9877700099',
          Branch: 'MAIN',
          'Joining Date': '01-01-2025',
          'Reports To': 'IMP-1',
        },
      ],
    });
    expect(r.body.rows[0].errors).toContain(
      'reports to "IMP-1" — no employee with that ID or mobile',
    );
  });
});
