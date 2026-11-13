#!/usr/bin/env node
/**
 * Creates a complete DEMO hospital with fictional data, so you can try every screen locally.
 *
 *   npm run seed:demo                 # organization code "demo-clinic"
 *   npm run seed:demo -- --slug other # another demo organization
 *
 * - Development by default. On a deployed server (staging/production) it runs only with
 *   --allow-deployed, for a pilot demo hospital with fictional data. Never mix it with real data.
 * - Every person, phone number and record is made up. Phone numbers use the +91 90000 00xxx range.
 * - Prints the staff logins with a freshly generated password (nothing is hardcoded).
 * - The privacy notice is placeholder text, clearly marked; it is not legal wording.
 *
 * It runs the real API in-process and calls it over HTTP, so every validation and permission
 * check applies, then adds some past visits and attendance directly for the analytics screens.
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/core/logger.js';
import { createDb, withSystem, withTenant } from '../src/core/db.js';
import { createMemoryStore } from '../src/core/rate-limit.js';
import { createMemorySms } from '../src/integrations/sms/index.js';
import { createMemoryWhatsApp } from '../src/integrations/whatsapp/index.js';
import { createOrganizationWithOwner } from '../src/modules/organizations/index.js';
import {
  generateTemporaryPassword,
  hashPassword,
} from '../src/modules/authentication/passwords.js';
import { addDays, dayOfWeek } from '../src/modules/hr-attendance/calc.js';
import { localDate } from '../src/modules/clinic/calc.js';

const { values } = parseArgs({
  options: {
    slug: { type: 'string', default: 'demo-clinic' },
    'allow-deployed': { type: 'boolean', default: false },
  },
});
const slug = values.slug;
if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) {
  console.error('--slug must be lowercase letters, digits and dashes');
  process.exit(1);
}

const config = loadConfig();
const deployed = !['development', 'test'].includes(config.APP_ENV);
if (deployed && !values['allow-deployed']) {
  console.error(
    `APP_ENV is ${config.APP_ENV}. To create a separate DEMO hospital with fictional data on this server, run again with --allow-deployed.`,
  );
  process.exit(1);
}
const db = createDb(config);

const exists = await withSystem(db, (trx) => trx('organizations').where({ slug }).first('id'));
if (exists) {
  console.error(
    `An organization with code "${slug}" already exists. Use --slug to choose another.`,
  );
  await db.destroy();
  process.exit(1);
}

// DEMO_PASSWORD (set as a secret, e.g. in the Render dashboard) avoids printing a password in logs.
const passwordFromEnv = process.env.DEMO_PASSWORD;
if (passwordFromEnv !== undefined && passwordFromEnv.length < 12) {
  console.error('DEMO_PASSWORD must be at least 12 characters.');
  await db.destroy();
  process.exit(1);
}
const password = passwordFromEnv || generateTemporaryPassword();
const passwordHash = await hashPassword(password);
const domain = `${slug}.test`;
const created = await createOrganizationWithOwner(db, {
  name: 'Sunrise Demo Hospital',
  slug,
  owner: { email: `owner@${domain}`, fullName: 'Demo Owner' },
  branch: { name: 'Main Branch', code: 'MAIN' },
  passwordHash,
});
const org = created.organization.id;
await withSystem(db, (trx) =>
  trx('users').where({ id: created.owner.id }).update({ must_change_password: false }),
);

// ---- run the API in-process (SMS is captured in memory, never sent)
const memorySms = createMemorySms();
const app = createApp({
  config,
  logger: createLogger({ ...config, LOG_LEVEL: 'silent' }),
  db,
  sms: memorySms,
  whatsapp: createMemoryWhatsApp(),
  rateLimitStore: createMemoryStore(),
  checks: {},
});
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const BASE = `http://127.0.0.1:${server.address().port}/api/v1`;
const H = { 'content-type': 'application/json', 'x-requested-with': 'healthos-web' };
let token;
async function call(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...H, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok)
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data?.error ?? data)}`);
  return data;
}
token = (await call('POST', '/auth/login', { email: `owner@${domain}`, password })).accessToken;

try {
  const branchId = created.branch.id;
  // Example coordinates (central Bengaluru). Change them under Branches to your real location.
  await call('PATCH', `/branches/${branchId}`, {
    address: 'Demo address, Bengaluru',
    location: { latitude: 12.9716, longitude: 77.5946 },
    geofenceRadiusM: 100,
  });

  // ---- staff logins
  const staff = {};
  for (const [key, name, role] of [
    ['admin', 'Demo Admin', 'organization_admin'],
    ['clinic', 'Demo Clinic Manager', 'clinic_manager'],
    ['clinic2', 'Demo Clinic Manager Two', 'clinic_manager'],
    ['reception', 'Demo Receptionist', 'receptionist'],
    ['reception2', 'Demo Receptionist Two', 'receptionist'],
    ['doctor', 'Dr. Kavya Demo', 'doctor'],
    ['doctor2', 'Dr. Arjun Demo', 'doctor'],
    ['nurse', 'Nisha Demo', 'nurse'],
    ['nurse2', 'Pooja Demo', 'nurse'],
    ['hr', 'Demo HR Manager', 'hr_manager'],
    ['hr2', 'Demo HR Manager Two', 'hr_manager'],
    ['payroll', 'Demo Payroll Manager', 'payroll_manager'],
    ['payroll2', 'Demo Payroll Manager Two', 'payroll_manager'],
    ['manager', 'Meena Demo', 'department_manager'],
    ['manager2', 'Vikram Demo', 'department_manager'],
  ]) {
    const [u] = await withTenant(db, org, (trx) =>
      trx('users')
        .insert({
          organization_id: org,
          email: `${key}@${domain}`,
          full_name: name,
          password_hash: passwordHash,
        })
        .returning('id'),
    );
    await withTenant(db, org, (trx) =>
      trx('user_role_assignments').insert({
        organization_id: org,
        user_id: u.id,
        role_key: role,
        branch_id: null,
      }),
    );
    staff[key] = u.id;
  }

  // ---- organisation structure
  const dept = {};
  for (const name of ['Clinical', 'Nursing', 'Front Office'])
    dept[name] = (await call('POST', '/departments', { name })).id;
  const desig = {};
  for (const name of ['Doctor', 'Staff Nurse', 'Receptionist', 'Manager'])
    desig[name] = (await call('POST', '/designations', { name })).id;
  const shift = await call('POST', '/shifts', {
    name: 'General 9–6',
    startTime: '09:00',
    endTime: '18:00',
    breakMinutes: 60,
  });
  const today = localDate('Asia/Kolkata');
  await call('POST', '/holidays', { date: addDays(today, 10), name: 'Demo festival holiday' });

  // ---- employees (fictional; mobiles in the +91 90000 00xxx range)
  // [name, mobile, designation, department, reports to, staff login key or null]
  const people = [
    ['Meena Demo', '9000000101', 'Manager', 'Front Office', null, 'manager'],
    ['Vikram Demo', '9000000109', 'Manager', 'Nursing', null, 'manager2'],
    ['Kavya Demo', '9000000105', 'Doctor', 'Clinical', null, 'doctor'],
    ['Arjun Demo', '9000000112', 'Doctor', 'Clinical', null, 'doctor2'],
    ['Nisha Demo', '9000000110', 'Staff Nurse', 'Nursing', 'Vikram Demo', 'nurse'],
    ['Pooja Demo', '9000000111', 'Staff Nurse', 'Nursing', 'Vikram Demo', 'nurse2'],
    // Employees who sign in with company code + mobile + code:
    ['Ravi Demo', '9000000102', 'Staff Nurse', 'Nursing', 'Vikram Demo', null],
    ['Sara Demo', '9000000103', 'Staff Nurse', 'Nursing', 'Vikram Demo', null],
    ['Divya Demo', '9000000108', 'Staff Nurse', 'Nursing', 'Vikram Demo', null],
    ['Imran Demo', '9000000104', 'Receptionist', 'Front Office', 'Meena Demo', null],
    ['Leela Demo', '9000000106', 'Receptionist', 'Front Office', 'Meena Demo', null],
    ['Kiran Demo', '9000000107', 'Receptionist', 'Front Office', 'Meena Demo', null],
  ];
  const emp = {};
  for (const [name, mobile, d, dp, manager, login] of people) {
    emp[name] = (
      await call('POST', '/hr/employees', {
        fullName: name,
        mobile,
        branchId,
        departmentId: dept[dp],
        designationId: desig[d],
        shiftId: shift.id,
        weeklyOffDays: [0],
        joiningDate: addDays(today, -400),
        reportingManagerId: manager ? emp[manager].id : null,
        // Doctors, nurses and managers also have email logins.
        userId: login ? staff[login] : null,
      })
    ).id;
    emp[name] = { id: emp[name] };
  }

  // ---- leave types
  await call('POST', '/leave/types', {
    name: 'Casual Leave',
    code: 'CL',
    annualQuota: 12,
    accrual: 'monthly',
  });
  await call('POST', '/leave/types', { name: 'Sick Leave', code: 'SL', annualQuota: 7 });

  // ---- attendance for the last two weeks (Mon–Sat), with some late and half days
  const pattern = [
    ['09:02', '18:10'],
    ['09:25', '18:30'],
    ['09:05', '14:30'],
    ['08:58', '19:45'],
    ['09:40', '18:05'],
    ['08:55', '18:00'],
  ];
  let k = 0;
  for (let back = 14; back >= 1; back--) {
    const date = addDays(today, -back);
    if (dayOfWeek(date) === 0) continue;
    for (const name of Object.keys(emp)) {
      const [checkIn, checkOut] = pattern[k++ % pattern.length];
      await call('PUT', `/attendance/employees/${emp[name].id}/days/${date}`, {
        checkIn,
        checkOut,
        reason: 'Demo data',
      });
    }
  }

  // ---- doctors and hours
  const doctorA = await call('POST', '/doctors', {
    displayName: 'Dr. Kavya Demo',
    specialization: 'General physician',
    branchId,
    userId: staff.doctor,
    consultationMinutes: 10,
  });
  const doctorB = await call('POST', '/doctors', {
    displayName: 'Dr. Arjun Demo',
    specialization: 'Paediatrics',
    branchId,
    userId: staff.doctor2,
    consultationMinutes: 12,
  });
  const week = [1, 2, 3, 4, 5, 6];
  await call('PUT', `/doctors/${doctorA.id}/schedule`, {
    sessions: week.flatMap((d) => [
      { dayOfWeek: d, startTime: '09:00', endTime: '13:00', slotMinutes: 10, patientsPerSlot: 1 },
      { dayOfWeek: d, startTime: '17:00', endTime: '20:00', slotMinutes: 10, patientsPerSlot: 1 },
    ]),
  });
  await call('PUT', `/doctors/${doctorB.id}/schedule`, {
    sessions: week.map((d) => ({
      dayOfWeek: d,
      startTime: '10:00',
      endTime: '14:00',
      slotMinutes: 15,
      patientsPerSlot: 2,
    })),
  });

  // ---- privacy notice (placeholder)
  const notice = await call('POST', '/privacy/notices', {
    version: 'DEMO-1',
    title: 'How we use your information (demo placeholder)',
    content:
      'DEMO PLACEHOLDER — NOT LEGAL TEXT.\n\nReplace this with a privacy notice written with your legal adviser. It should explain what personal data you collect, why, how long you keep it, who you share it with, and how patients can access, correct or erase their data or raise a grievance.',
  });
  await call('POST', `/privacy/notices/${notice.id}/publish`);

  // ---- patients (one family sharing a phone, plus others)
  const patients = {};
  const register = async (fullName, dateOfBirth, phone, relationship = 'self', gender = null) => {
    const p = await call('POST', '/patients', {
      fullName,
      dateOfBirth,
      gender,
      phone,
      relationship,
      branchId,
      privacyNoticeAcknowledged: true,
      consents: { whatsappService: true, smsService: true, marketing: false },
      confirmNotDuplicate: true,
    });
    patients[fullName] = p.id;
  };
  await register('Asha Demo', '1988-04-12', '9000000201', 'self', 'female');
  await register('Kabir Demo', '2016-09-01', '9000000201', 'child', 'male');
  await register('Rohit Demo', '1979-01-23', '9000000202', 'self', 'male');
  await register('Fatima Demo', '1995-07-30', '9000000203', 'self', 'female');
  await register('Gopal Demo', '1950-11-05', '9000000204', 'self', 'male');
  await register('Lata Demo', '1960-02-14', '9000000201', 'parent', 'female');
  await register('Priya Demo', '1983-06-21', '9000000202', 'spouse', 'female');
  await register('Neha Demo', '1993-08-19', '9000000205', 'self', 'female');
  await register('Arun Demo', '1971-12-02', '9000000206', 'self', 'male');
  // Lata was added "online" by her daughter: she waits for the hospital's check (Patient privacy).
  await withTenant(db, org, (trx) =>
    trx('contact_patient_links')
      .where({ organization_id: org, patient_id: patients['Lata Demo'] })
      .update({
        authorization_status: 'pending',
        authorized_at: null,
        authorized_by_user_id: null,
        created_via: 'portal',
      }),
  );
  // A look-alike registration for the duplicate review list (never merged automatically).
  await register('Aasha Demo', '1988-04-12', '9000000209', 'self', 'female');

  // ---- today's bookings (future slots only)
  const book = async (patient, doctor) => {
    const { slots } = await call('GET', `/doctors/${doctor.id}/slots?date=${today}`);
    const slot = slots.find((s) => s.available);
    if (slot)
      await call('POST', '/appointments', {
        patientId: patients[patient],
        doctorId: doctor.id,
        slotStart: slot.start,
      });
  };
  await book('Asha Demo', doctorA);
  await book('Rohit Demo', doctorA);
  await book('Kabir Demo', doctorB);

  // ---- two weeks of past visits for the analytics screens (direct inserts, clearly synthetic)
  await withTenant(db, org, async (trx) => {
    const ids = Object.values(patients);
    for (let back = 14; back >= 1; back--) {
      const date = addDays(today, -back);
      if (dayOfWeek(date) === 0) continue;
      let token = 0;
      for (const [i, pid] of ids.entries()) {
        for (const doctor of [doctorA, doctorB]) {
          if ((back + i) % 3 === 0 && doctor === doctorB) continue;
          token += 1;
          const noShow = (back + i) % 7 === 0;
          const arrive =
            new Date(`${date}T03:30:00Z`).getTime() + (token * 9 + (i % 3) * 7) * 60_000;
          const called = arrive + (10 + ((back * 3 + i) % 25)) * 60_000;
          const done = called + (6 + ((back + i) % 9)) * 60_000;
          await trx('queue_entries').insert({
            organization_id: org,
            branch_id: branchId,
            doctor_id: doctor.id,
            queue_date: date,
            patient_id: pid,
            token_number: token,
            kind: 'walk_in',
            status: noShow ? 'no_show' : 'completed',
            tracking_code: randomBytes(12).toString('base64url'),
            checked_in_at: noShow ? null : new Date(arrive),
            called_at: noShow ? null : new Date(called),
            started_at: noShow ? null : new Date(called),
            completed_at: noShow ? null : new Date(done),
          });
        }
      }
      await trx('queue_counters')
        .insert({
          organization_id: org,
          doctor_id: doctorA.id,
          queue_date: date,
          last_token: token,
        })
        .onConflict(['organization_id', 'doctor_id', 'queue_date'])
        .merge();
      await trx('queue_counters')
        .insert({
          organization_id: org,
          doctor_id: doctorB.id,
          queue_date: date,
          last_token: token,
        })
        .onConflict(['organization_id', 'doctor_id', 'queue_date'])
        .merge();
    }
  });

  // ---- last month: full attendance, salaries and an APPROVED payroll run
  const [ty, tm] = today.split('-').map(Number);
  const prev = tm === 1 ? `${ty - 1}-12` : `${ty}-${String(tm - 1).padStart(2, '0')}`;
  const prevDays = new Date(
    Date.UTC(Number(prev.slice(0, 4)), Number(prev.slice(5, 7)), 0),
  ).getUTCDate();
  const monthPattern = [
    ['09:02', '18:10'],
    ['09:24', '18:30'],
    ['09:05', '18:20'],
    ['08:58', '19:40'],
    ['09:41', '18:05'],
    ['08:55', '18:00'],
    ['09:00', '13:30'],
  ];
  let m = 0;
  for (const [name] of people) {
    for (let d = 1; d <= prevDays; d++) {
      const date = `${prev}-${String(d).padStart(2, '0')}`;
      if (dayOfWeek(date) === 0) continue;
      if ((d * 7 + m) % 23 === 0) {
        m++;
        continue; // an occasional absence
      }
      const [checkIn, checkOut] = monthPattern[(m++ + d) % monthPattern.length];
      await call('PUT', `/attendance/employees/${emp[name].id}/days/${date}`, {
        checkIn,
        checkOut,
        reason: 'Demo data',
      });
    }
  }
  await call('PUT', '/attendance/policy', {
    fullDayMinutes: 480,
    halfDayMinutes: 240,
    belowHalfDayStatus: 'absent',
    lateGraceMinutes: 10,
    lateFreePerMonth: 2,
    latePenaltyMode: 'half_day_per_n',
    latePenaltyEveryN: 3,
    overtimeAfterMinutes: 540,
    minPunchGapSeconds: 60,
  });
  const basic = await call('POST', '/payroll/components', {
    name: 'Basic',
    code: 'BASIC',
    kind: 'earning',
    displayOrder: 1,
  });
  await call('POST', '/payroll/components', {
    name: 'House rent allowance',
    code: 'HRA',
    kind: 'earning',
    calc: 'percent_of_component',
    percent: '40',
    baseComponentId: basic.id,
    displayOrder: 2,
  });
  const conveyance = await call('POST', '/payroll/components', {
    name: 'Conveyance',
    code: 'CONV',
    kind: 'earning',
    displayOrder: 3,
  });
  const basicPay = {
    'Kavya Demo': '60000',
    'Arjun Demo': '55000',
    'Meena Demo': '32000',
    'Vikram Demo': '34000',
  };
  for (const [name, , designation] of people) {
    await call('POST', '/payroll/structures', {
      employeeId: emp[name].id,
      effectiveFrom: addDays(today, -400),
      lines: [
        {
          componentId: basic.id,
          amount: basicPay[name] ?? (designation === 'Staff Nurse' ? '21000' : '16000'),
        },
        { componentId: conveyance.id, amount: '1600' },
      ],
    });
  }
  await call('POST', '/payroll/policies', {
    name: 'Staff canteen',
    code: 'CANTEEN',
    kind: 'deduction',
    calc: 'fixed',
    amount: '300',
    effectiveFrom: addDays(today, -400),
  });
  await call('POST', '/payroll/policies', {
    name: 'Overtime pay',
    code: 'OT',
    kind: 'earning',
    calc: 'per_unit',
    unitMetric: 'overtime_hours',
    unitRate: 'hourly_rate',
    multiplier: '1.5',
    effectiveFrom: addDays(today, -400),
  });
  const run = await call('POST', '/payroll/runs', { month: prev });
  await call('POST', `/payroll/runs/${run.id}/calculate`);
  await call('POST', `/payroll/runs/${run.id}/approve`, { confirm: true });

  // ---- leave requests (employees sign in with their code; Vikram approves one)
  const employeeToken = async (mobile) => {
    const r = await call('POST', '/auth/employee/request-otp', { company: slug, mobile });
    const code = r.demoCode ?? memorySms.lastCodeFor(`+91${mobile}`);
    return (await call('POST', '/auth/employee/verify-otp', { company: slug, mobile, code }))
      .accessToken;
  };
  const asUser = async (t, fn) => {
    const saved = token;
    token = t;
    try {
      return await fn();
    } finally {
      token = saved;
    }
  };
  const types = (await call('GET', '/leave/types')).data;
  const cl = types.find((t) => t.code === 'CL');
  const sl = types.find((t) => t.code === 'SL');
  const ravi = await employeeToken('9000000102');
  const leave = await asUser(ravi, () =>
    call('POST', '/me/leave/requests', {
      leaveTypeId: cl.id,
      startDate: addDays(today, 7),
      endDate: addDays(today, 8),
      reason: 'Family function',
    }),
  );
  const sara = await employeeToken('9000000103');
  await asUser(sara, () =>
    call('POST', '/me/leave/requests', {
      leaveTypeId: sl.id,
      startDate: addDays(today, 2),
      endDate: addDays(today, 2),
      reason: 'Doctor appointment',
    }),
  );
  const vikram = (await call('POST', '/auth/login', { email: `manager2@${domain}`, password }))
    .accessToken;
  await asUser(vikram, () => call('POST', `/leave/requests/${leave.id}/approve`, {}));

  // ---- messages
  const hrToken = (await call('POST', '/auth/login', { email: `hr@${domain}`, password }))
    .accessToken;
  await asUser(hrToken, () =>
    call('POST', '/messages', {
      category: 'general',
      title: 'Health check-up camp on Saturday',
      body: 'Free health check-up for all staff this Saturday, 10 am to 1 pm, in the OPD.',
      audience: { type: 'all' },
    }),
  );
  await asUser(vikram, () =>
    call('POST', '/messages', {
      category: 'performance',
      title: 'Thank you for covering the evening shift',
      body: 'Great teamwork this week. Thank you, Ravi.',
      audience: { type: 'employees', employeeIds: [emp['Ravi Demo'].id] },
    }),
  );

  // ---- a platform-console login for the operator's team (not part of any hospital)
  const platformEmail = `platform@${domain}`;
  const platformEmail2 = `platform2@${domain}`;
  await withSystem(db, async (trx) => {
    for (const [email, name] of [
      [platformEmail, 'Demo Platform Admin'],
      [platformEmail2, 'Demo Platform Admin Two'],
    ]) {
      await trx('platform_admins')
        .insert({
          email,
          full_name: name,
          password_hash: passwordHash,
          must_change_password: false,
        })
        .onConflict(trx.raw('(lower(email))'))
        .ignore();
    }
  });

  const web = config.FRONTEND_URL.replace(/\/$/, '');
  const patientSite = config.PATIENT_SITE_URL.replace(/\/$/, '');
  console.log(`
Demo hospital created: Sunrise Demo Hospital (hospital code: ${slug})
Every login below uses ${passwordFromEnv ? 'the DEMO_PASSWORD you set' : `this password (shown once):  ${password}`}

PLATFORM CONSOLE (your team)   ${web}/platform
  ${platformEmail}   ${platformEmail2}

STAFF (email + password)       ${web}/login
  Owner / admin        owner@${domain}  admin@${domain}
  Clinic managers      clinic@${domain}  clinic2@${domain}
  Receptionists        reception@${domain}  reception2@${domain}
  Doctors              doctor@${domain} (Dr. Kavya)  doctor2@${domain} (Dr. Arjun)
  Nurses               nurse@${domain} (Nisha)  nurse2@${domain} (Pooja)
  HR managers          hr@${domain}  hr2@${domain}
  Payroll managers     payroll@${domain}  payroll2@${domain}
  Department managers  manager@${domain} (Meena: Imran, Leela, Kiran)
                       manager2@${domain} (Vikram: Ravi, Sara, Divya, Nisha, Pooja)

EMPLOYEES (company code + mobile + code)   ${web}/employee-login   company code: ${slug}
  9000000102 Ravi · 9000000103 Sara · 9000000108 Divya · 9000000104 Imran · 9000000106 Leela · 9000000107 Kiran

PATIENTS (mobile + code)       ${patientSite}   hospital code: ${slug}
  9000000201 Asha, her son Kabir, her mother Lata (awaiting hospital check)
  9000000202 Rohit and his wife Priya · 9000000203 Fatima · 9000000204 Gopal · 9000000205 Neha · 9000000206 Arun

SIGN-IN CODES: locally printed in the API terminal; on the demo deployment (SMS_DEMO_CODES=true)
shown on screen for these demo numbers; otherwise sent by MSG91.
Everything here is fictional demo data.
`);
} finally {
  server.close();
  await db.destroy();
}
