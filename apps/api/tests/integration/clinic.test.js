import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addUser, bearer, createTenant, login, setupTestApp, sys } from './helpers.js';
import { addDays } from '../../src/modules/hr-attendance/calc.js';
import { localDate } from '../../src/modules/clinic/calc.js';

// Fictional people only.
const { app, db } = setupTestApp();
let t;
let other;
let owner;
let reception;
let hr;
let doctorUser;
let docA;
let docB;
const patients = [];
const today = localDate('Asia/Kolkata');
const tomorrow = addDays(today, 1);

const api = (token) => ({
  get: (url) => request(app).get(`/api/v1${url}`).set(bearer(token)),
  post: (url, body = {}, headers = {}) =>
    request(app).post(`/api/v1${url}`).set(bearer(token)).set(headers).send(body),
  put: (url, body) => request(app).put(`/api/v1${url}`).set(bearer(token)).send(body),
});

async function makePatients(orgId, n) {
  const rows = Array.from({ length: n }, (_, i) => ({
    organization_id: orgId,
    patient_number: `T-${randomUUID().slice(0, 8).toUpperCase()}`,
    full_name: `Test Patient ${i + 1}`,
    registration_source: 'reception',
  }));
  return sys(db, (x) => x('patients').insert(rows).returning('*'));
}

const allDay = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
  dayOfWeek: d,
  startTime: '00:00',
  endTime: '23:55',
  slotMinutes: 5,
  patientsPerSlot: 1,
}));
const firstFree = async (doctorId, date) =>
  (await reception.get(`/doctors/${doctorId}/slots?date=${date}`)).body.slots.find(
    (s) => s.available,
  );

beforeAll(async () => {
  t = await createTenant(db, 'clin');
  other = await createTenant(db, 'clinb');
  owner = api((await login(app, t.owner.email)).token);
  reception = api(
    (await login(app, (await addUser(db, t.organization.id, ['receptionist'], 'rec')).email)).token,
  );
  hr = api(
    (await login(app, (await addUser(db, t.organization.id, ['hr_manager'], 'hr')).email)).token,
  );
  const docUserRow = await addUser(db, t.organization.id, ['doctor'], 'doc');
  doctorUser = api((await login(app, docUserRow.email)).token);
  docA = (
    await owner.post('/doctors', {
      displayName: 'Dr. Test Alpha',
      branchId: t.branch.id,
      userId: docUserRow.id,
      consultationMinutes: 10,
    })
  ).body;
  docB = (await owner.post('/doctors', { displayName: 'Dr. Test Beta', branchId: t.branch.id }))
    .body;
  patients.push(...(await makePatients(t.organization.id, 12)));
});
afterAll(() => db.destroy());

describe('doctors and schedules', () => {
  it('only doctor managers create doctors and set schedules', async () => {
    expect(docA.id).toBeTruthy();
    expect(
      (await reception.post('/doctors', { displayName: 'Dr X', branchId: t.branch.id })).status,
    ).toBe(403);
    expect((await hr.get('/doctors')).status).toBe(403);
    const overlap = await owner.put(`/doctors/${docA.id}/schedule`, {
      sessions: [
        { dayOfWeek: 1, startTime: '09:00', endTime: '12:00', slotMinutes: 10 },
        { dayOfWeek: 1, startTime: '11:00', endTime: '13:00', slotMinutes: 10 },
      ],
    });
    expect(overlap.body.error.code).toBe('SCHEDULE_OVERLAP');
    for (const d of [docA, docB]) {
      expect((await owner.put(`/doctors/${d.id}/schedule`, { sessions: allDay })).status).toBe(200);
    }
    const slots = await reception.get(`/doctors/${docA.id}/slots?date=${tomorrow}`);
    expect(slots.body.slots).toHaveLength(287);
  });
});

describe('booking', () => {
  let first;

  it('books with a token; retrying with the same idempotency key does not double book', async () => {
    const slot = await firstFree(docA.id, tomorrow);
    const body = { patientId: patients[0].id, doctorId: docA.id, slotStart: slot.start };
    const headers = { 'Idempotency-Key': 'booking-key-0001' };
    const r1 = await reception.post('/appointments', body, headers);
    expect(r1.status).toBe(201);
    expect(r1.body.queue).toMatchObject({ token: 1, status: 'booked' });
    const r2 = await reception.post('/appointments', body, headers);
    expect(r2.status).toBe(200);
    expect(r2.body.id).toBe(r1.body.id);
    first = r1.body;
    const again = await reception.post('/appointments', {
      ...body,
      slotStart: (await firstFree(docA.id, tomorrow)).start,
    });
    expect(again.body.error.code).toBe('ALREADY_BOOKED');
  });

  it('concurrent bookings never share a token or overfill a slot', async () => {
    const slots = (
      await reception.get(`/doctors/${docA.id}/slots?date=${tomorrow}`)
    ).body.slots.filter((s) => s.available);
    const results = await Promise.all(
      patients.slice(1, 7).map((p, i) =>
        reception.post('/appointments', {
          patientId: p.id,
          doctorId: docA.id,
          slotStart: slots[i].start,
        }),
      ),
    );
    const tokens = results.map((r) => r.body.queue.token).sort((a, b) => a - b);
    expect(tokens).toEqual([2, 3, 4, 5, 6, 7]);

    const target = slots[10];
    const race = await Promise.all(
      patients.slice(7, 11).map((p) =>
        reception.post('/appointments', {
          patientId: p.id,
          doctorId: docA.id,
          slotStart: target.start,
        }),
      ),
    );
    expect(race.filter((r) => r.status === 201)).toHaveLength(1);
    expect(race.filter((r) => r.body.error?.code === 'SLOT_FULL')).toHaveLength(3);
  });

  it('time off closes the day; reschedule and cancel keep history', async () => {
    const off = await owner.post(`/doctors/${docB.id}/time-off`, {
      date: tomorrow,
      reason: 'Conference',
    });
    expect(off.body.affectedAppointments).toBe(0);
    const slots = await reception.get(`/doctors/${docB.id}/slots?date=${tomorrow}`);
    expect(slots.body).toMatchObject({ timeOff: 'Conference', slots: [] });

    const moved = await reception.post(`/appointments/${first.id}/reschedule`, {
      slotStart: (await firstFree(docA.id, addDays(today, 2))).start,
      reason: 'Patient asked',
    });
    expect(moved.status).toBe(201);
    expect(moved.body.date).toBe(addDays(today, 2));
    const old = await reception.get(`/appointments?patientId=${patients[0].id}`);
    expect(old.body.data.map((a) => a.status).sort()).toEqual(['booked', 'cancelled']);
    const cancel = await reception.post(`/appointments/${moved.body.id}/cancel`, {
      reason: 'Feeling better',
    });
    expect(cancel.body.status).toBe('cancelled');
  });
});

describe('today’s queue', () => {
  let appt;
  let walkIn;
  let urgent;

  it('appointments and walk-ins share one token sequence per doctor and day', async () => {
    const slot = await firstFree(docA.id, today);
    appt = (
      await reception.post('/appointments', {
        patientId: patients[0].id,
        doctorId: docA.id,
        slotStart: slot.start,
      })
    ).body;
    walkIn = (
      await reception.post('/queue/walk-ins', { patientId: patients[1].id, doctorId: docA.id })
    ).body;
    urgent = (
      await reception.post('/queue/walk-ins', {
        patientId: patients[2].id,
        doctorId: docA.id,
        priority: 2,
        priorityReason: 'Elderly patient, unwell',
      })
    ).body;
    expect([appt.queue.token, walkIn.token, urgent.token]).toEqual([1, 2, 3]);
    expect(walkIn.status).toBe('waiting');
    const dup = await reception.post('/queue/walk-ins', {
      patientId: patients[1].id,
      doctorId: docA.id,
    });
    expect(dup.body.error.code).toBe('ALREADY_BOOKED');
  });

  it('the patient link shows token, position and an approximate wait, without names', async () => {
    const r = await request(app).get(`/api/v1/public/track/${appt.queue.trackingCode}`);
    expect(r.body).toMatchObject({
      token: 1,
      status: 'booked',
      ahead: 1, // the priority walk-in goes first
      estimatedWaitMinutes: 10,
      estimateIsApproximate: true,
    });
    expect(JSON.stringify(r.body)).not.toContain('Test Patient');
    expect((await request(app).get('/api/v1/public/track/AAAAAAAAAAAAAAAA')).status).toBe(404);
  });

  it('calls the next arrived patient by priority, then token', async () => {
    const n1 = await doctorUser.post('/queue/call-next', { doctorId: docA.id });
    expect(n1.body.token).toBe(3);
    await doctorUser.post(`/queue/entries/${n1.body.id}/start`);
    await doctorUser.post(`/queue/entries/${n1.body.id}/complete`);
    const checkin = await reception.post(`/queue/entries/${appt.queue.entryId}/check-in`);
    expect(checkin.body.status).toBe('waiting');
    const n2 = await doctorUser.post('/queue/call-next', { doctorId: docA.id });
    expect(n2.body.token).toBe(1);
    const track = await request(app).get(`/api/v1/public/track/${walkIn.trackingCode}`);
    expect(track.body).toMatchObject({ nowServingToken: 1, ahead: 1 });
  });

  it('doctors manage only their own queue and cannot cancel', async () => {
    expect((await doctorUser.post('/queue/call-next', { doctorId: docB.id })).status).toBe(403);
    expect(
      (await doctorUser.post(`/queue/entries/${walkIn.id}/cancel`, { reason: 'test reason' }))
        .status,
    ).toBe(403);
    expect((await doctorUser.post('/appointments', {})).status).toBe(403);
  });

  it('closing the day marks the rest as no-shows; dashboard and visit history', async () => {
    const closed = await reception.post('/queue/close-day', { doctorId: docA.id, date: today });
    expect(closed.body.noShows).toBe(2);
    const summary = await reception.get('/queue/summary');
    const row = summary.body.data.find((d) => d.doctor.id === docA.id);
    expect(row.counts).toMatchObject({ completed: 1, noShow: 2 });
    expect(row.walkIns).toBe(2);
    const visits = await reception.get(`/queue/visits?patientId=${patients[2].id}`);
    expect(visits.body.data.find((v) => v.date === today)).toMatchObject({
      status: 'completed',
      doctorName: 'Dr. Test Alpha',
    });
  });

  it('is isolated per organization', async () => {
    const o = api((await login(app, other.owner.email)).token);
    expect((await o.get('/doctors')).body.data).toEqual([]);
    expect((await o.get(`/queue?doctorId=${docA.id}`)).status).toBe(404);
    expect((await o.get(`/appointments?patientId=${patients[0].id}`)).body.data).toEqual([]);
    expect((await o.post(`/queue/entries/${walkIn.id}/check-in`)).status).toBe(404);
    expect(
      (await o.post('/queue/walk-ins', { patientId: patients[3].id, doctorId: docA.id })).status,
    ).toBe(404);
  });
});
