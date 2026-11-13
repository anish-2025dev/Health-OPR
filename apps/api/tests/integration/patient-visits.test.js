import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addUser, bearer, createTenant, login, setupTestApp, sys } from './helpers.js';
import { addDays } from '../../src/modules/hr-attendance/calc.js';
import { localDate } from '../../src/modules/clinic/calc.js';

// Deactivating or merging a patient must not leave them in any queue. Fictional people only.
const { app, db } = setupTestApp();
let t;
let owner;
let reception;
let doc;
let other;
let otherDoc;
const tomorrow = addDays(localDate('Asia/Kolkata'), 1);

const api = (token) => ({
  get: (url) => request(app).get(`/api/v1${url}`).set(bearer(token)),
  post: (url, body = {}) => request(app).post(`/api/v1${url}`).set(bearer(token)).send(body),
  put: (url, body) => request(app).put(`/api/v1${url}`).set(bearer(token)).send(body),
  patch: (url, body) => request(app).patch(`/api/v1${url}`).set(bearer(token)).send(body),
});

const allDay = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
  dayOfWeek: d,
  startTime: '00:00',
  endTime: '23:55',
  slotMinutes: 5,
  patientsPerSlot: 1,
}));

async function makePatient(orgId, name) {
  const [p] = await sys(db, (x) =>
    x('patients')
      .insert({
        organization_id: orgId,
        patient_number: `T-${randomUUID().slice(0, 8).toUpperCase()}`,
        full_name: name,
        registration_source: 'reception',
      })
      .returning('*'),
  );
  return p;
}

async function book(patientId, doctorId) {
  const slot = (await reception.get(`/doctors/${doctorId}/slots?date=${tomorrow}`)).body.slots.find(
    (s) => s.available,
  );
  const r = await reception.post('/appointments', { patientId, doctorId, slotStart: slot.start });
  expect(r.status).toBe(201);
  return r.body;
}
const walkIn = async (patientId, doctorId) => {
  const r = await reception.post('/queue/walk-ins', { patientId, doctorId });
  expect(r.status).toBe(201);
  return r.body;
};
const entry = (id) => sys(db, (x) => x('queue_entries').where({ id }).first());
const appointment = (id) => sys(db, (x) => x('appointments').where({ id }).first());

beforeAll(async () => {
  t = await createTenant(db, 'visits');
  owner = api((await login(app, t.owner.email)).token);
  reception = api(
    (await login(app, (await addUser(db, t.organization.id, ['receptionist'], 'rec')).email)).token,
  );
  doc = (await owner.post('/doctors', { displayName: 'Dr. Test Visits', branchId: t.branch.id }))
    .body;
  otherDoc = (await owner.post('/doctors', { displayName: 'Dr. Test Two', branchId: t.branch.id }))
    .body;
  for (const d of [doc, otherDoc])
    await owner.put(`/doctors/${d.id}/schedule`, { sessions: allDay });
  other = await createTenant(db, 'visitsb');
});
afterAll(() => db.destroy());

describe('marking a patient inactive', () => {
  it('cancels their bookings and queue tokens and keeps the history', async () => {
    const p = await makePatient(t.organization.id, 'Test Inactive One');
    const appt = await book(p.id, doc.id);
    const w = await walkIn(p.id, doc.id);

    const r = await reception.patch(`/patients/${p.id}`, { status: 'inactive' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('inactive');
    expect((await appointment(appt.id)).status).toBe('cancelled');
    expect((await entry(appt.queue.entryId)).status).toBe('cancelled');
    expect((await entry(w.id)).status).toBe('cancelled');

    const today = (await reception.get(`/queue?doctorId=${doc.id}`)).body;
    expect(today.entries.find((e) => e.id === w.id).status).toBe('cancelled');
    expect(today.counts.waiting).toBe(0);
    // Records are never deleted, and an inactive patient can't be booked again.
    expect(
      (await reception.post('/queue/walk-ins', { patientId: p.id, doctorId: doc.id })).status,
    ).toBe(409);
    expect((await reception.patch(`/patients/${p.id}`, { status: 'active' })).status).toBe(200);
  });

  it('refuses while the patient is with a doctor', async () => {
    const p = await makePatient(t.organization.id, 'Test In Consultation');
    const w = await walkIn(p.id, otherDoc.id);
    expect((await reception.post(`/queue/entries/${w.id}/start`)).status).toBe(200);
    const r = await reception.patch(`/patients/${p.id}`, { status: 'inactive' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('PATIENT_IN_CONSULTATION');
    expect((await entry(w.id)).status).toBe('in_consultation');
  });

  it("can't touch another hospital's patient", async () => {
    const p = await makePatient(other.organization.id, 'Test Other Hospital');
    expect((await reception.patch(`/patients/${p.id}`, { status: 'inactive' })).status).toBe(404);
  });
});

describe('merging a duplicate', () => {
  it('moves open bookings to the kept record and cancels clashing ones', async () => {
    const keep = await makePatient(t.organization.id, 'Test Merge Keep');
    const dup = await makePatient(t.organization.id, 'Test Merge Dup');
    const keepAppt = await book(keep.id, doc.id);
    const dupClash = await book(dup.id, doc.id); // same doctor, same day as the kept booking
    const dupMove = await book(dup.id, otherDoc.id);
    const [flag] = await sys(db, (x) =>
      x('patient_duplicate_flags')
        .insert({
          organization_id: t.organization.id,
          patient_id: dup.id,
          candidate_patient_id: keep.id,
          score: 0.9,
        })
        .returning('id'),
    );

    const r = await owner.post(`/privacy/duplicates/${flag.id}/decide`, {
      decision: 'duplicate',
      keepPatientId: keep.id,
      reason: 'Same person confirmed at the desk',
    });
    expect(r.status).toBe(200);
    expect(r.body.merged.visits).toEqual({ appointments: 1, queueEntries: 0, cancelled: 1 });

    expect(await appointment(dupMove.id)).toMatchObject({ patient_id: keep.id, status: 'booked' });
    expect((await entry(dupMove.queue.entryId)).patient_id).toBe(keep.id);
    expect((await appointment(dupClash.id)).status).toBe('cancelled');
    expect((await entry(dupClash.queue.entryId)).status).toBe('cancelled');
    expect((await appointment(keepAppt.id)).status).toBe('booked');
  });
});
