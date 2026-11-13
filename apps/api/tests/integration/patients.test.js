import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { CSRF, addUser, bearer, createTenant, login, setupTestApp, sys } from './helpers.js';

// Fictional people only.
const { app, db, sms } = setupTestApp();
let t;
let other;
let owner;
let reception;
let doctor;
let hr;
let otherOwner;

const api = (token) => ({
  get: (url) => request(app).get(`/api/v1${url}`).set(bearer(token)),
  post: (url, body = {}) => request(app).post(`/api/v1${url}`).set(bearer(token)).send(body),
  patch: (url, body) => request(app).patch(`/api/v1${url}`).set(bearer(token)).send(body),
  put: (url, body) => request(app).put(`/api/v1${url}`).set(bearer(token)).send(body),
});
const as = async (roles, label) =>
  api((await login(app, (await addUser(db, t.organization.id, roles, label)).email)).token);

const NOTICE = {
  version: '2026.1',
  title: 'How we use your information',
  content: 'Placeholder privacy notice text for tests. Not legal wording.',
};
const register = (body) =>
  reception.post('/patients', {
    branchId: t.branch.id,
    privacyNoticeAcknowledged: true,
    ...body,
  });

beforeAll(async () => {
  t = await createTenant(db, 'pat');
  other = await createTenant(db, 'patb');
  owner = api((await login(app, t.owner.email)).token);
  otherOwner = api((await login(app, other.owner.email)).token);
  reception = await as(['receptionist'], 'rec');
  doctor = await as(['doctor'], 'doc');
  hr = await as(['hr_manager'], 'hr');
});
afterAll(() => db.destroy());

describe('privacy notices', () => {
  it('registration needs a published notice', async () => {
    const r = await register({ fullName: 'Asha Verma', phone: '9811100001' });
    expect(r.body.error.code).toBe('NOTICE_NOT_PUBLISHED');
  });

  it('notices are versioned; published wording is locked', async () => {
    expect((await reception.post('/privacy/notices', NOTICE)).status).toBe(403);
    const draft = await owner.post('/privacy/notices', NOTICE);
    expect(draft.body.status).toBe('draft');
    const pub = await owner.post(`/privacy/notices/${draft.body.id}/publish`);
    expect(pub.body.status).toBe('published');
    const edit = await owner.patch(`/privacy/notices/${draft.body.id}`, { title: 'Changed title' });
    expect(edit.body.error.code).toBe('NOTICE_LOCKED');
  });
});

describe('reception registration', () => {
  let asha;

  it('registers a patient with separate consent records', async () => {
    const r = await register({
      fullName: 'Asha Verma',
      dateOfBirth: '1990-04-01',
      gender: 'female',
      phone: '9811100001',
      consents: { whatsappService: true, smsService: false, marketing: false },
    });
    expect(r.status).toBe(201);
    asha = r.body;
    expect(asha.patientNumber).toMatch(/^P-\d{6}$/);
    expect(asha.contacts[0]).toMatchObject({
      phone: '+919811100001',
      relationship: 'self',
      authorizationStatus: 'authorized',
    });
    expect(asha.consents.privacy_notice).toMatchObject({
      status: 'granted',
      noticeVersion: '2026.1',
    });
    expect(asha.consents.whatsapp_service.status).toBe('granted');
    expect(asha.consents.marketing.status).toBe('not_given');
  });

  it('requires the privacy notice acknowledgement', async () => {
    const r = await reception.post('/patients', {
      branchId: t.branch.id,
      fullName: 'No Ack',
      phone: '9811100009',
    });
    expect(r.status).toBe(400);
  });

  it('one phone number can be linked to several separate family patients', async () => {
    const child = await register({
      fullName: 'Kabir Verma',
      dateOfBirth: '2018-06-10',
      phone: '9811100001',
      relationship: 'child',
    });
    expect(child.status).toBe(201);
    expect(child.body.id).not.toBe(asha.id);
    const found = await reception.get('/patients?phone=9811100001');
    expect(found.body.data.map((p) => p.fullName).sort()).toEqual(['Asha Verma', 'Kabir Verma']);
  });

  it('flags possible duplicates for review and never merges automatically', async () => {
    const dup = await register({
      fullName: 'Aasha Verma',
      dateOfBirth: '1990-04-01',
      phone: '9811100002',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('POSSIBLE_DUPLICATE');
    expect(dup.body.error.details.matches[0].patientId).toBe(asha.id);

    const confirmed = await register({
      fullName: 'Aasha Verma',
      dateOfBirth: '1990-04-01',
      phone: '9811100002',
      confirmNotDuplicate: true,
    });
    expect(confirmed.status).toBe(201);
    const reviews = await owner.get('/privacy/duplicates');
    expect(reviews.body.data).toHaveLength(1);
    expect(reviews.body.data[0].candidate.id).toBe(asha.id);
    // both records still exist
    expect((await reception.get(`/patients/${asha.id}`)).body.status).toBe('active');
    expect((await reception.get(`/patients/${confirmed.body.id}`)).body.status).toBe('active');
  });

  it('staff can merge after review: the record is kept, links move, nothing is deleted', async () => {
    const [flag] = (await owner.get('/privacy/duplicates')).body.data;
    const r = await owner.post(`/privacy/duplicates/${flag.id}/decide`, {
      decision: 'duplicate',
      keepPatientId: asha.id,
      reason: 'Same person confirmed at the desk',
    });
    expect(r.body.merged).toMatchObject({
      keptPatientId: asha.id,
      mergedPatientId: flag.patient.id,
    });
    const merged = (await reception.get(`/patients/${flag.patient.id}`)).body;
    expect(merged).toMatchObject({ status: 'merged', mergedIntoPatientId: asha.id });
    const kept = (await reception.get(`/patients/${asha.id}`)).body;
    expect(kept.contacts.map((c) => c.phone).sort()).toEqual(['+919811100001', '+919811100002']);
  });

  it('withdrawing consent changes communication eligibility; history is kept', async () => {
    const r = await reception.post(`/patients/${asha.id}/consents`, { whatsappService: false });
    expect(r.body.consents.whatsapp_service.status).toBe('withdrawn');
    const history = await reception.get(`/patients/${asha.id}/consents`);
    expect(
      history.body.data.filter((c) => c.purpose === 'whatsapp_service').map((c) => c.status),
    ).toEqual(['withdrawn', 'granted']);
    const { communicationAllowed } = await import('../../src/modules/patients/service.js');
    const allowed = await sys(db, (x) =>
      communicationAllowed(x, t.organization.id, asha.id, 'whatsapp'),
    );
    expect(allowed).toBe(false);
  });

  it('doctors see masked phone numbers; HR roles have no patient access', async () => {
    const r = await doctor.get(`/patients/${asha.id}`);
    expect(r.body.contacts[0].phone).toMatch(/•+0001$/);
    expect(r.body.email).toBeUndefined();
    expect((await doctor.post('/patients', {})).status).toBe(403);
    expect((await hr.get('/patients')).status).toBe(403);
  });

  it('records data principal requests', async () => {
    const r = await reception.post('/privacy/requests', {
      patientId: asha.id,
      requestType: 'correction',
      details: 'Spelling of the name',
    });
    expect(r.status).toBe(201);
    const done = await owner.patch(`/privacy/requests/${r.body.id}`, { status: 'completed' });
    expect(done.status).toBe(400);
    const ok = await owner.patch(`/privacy/requests/${r.body.id}`, {
      status: 'completed',
      resolution: 'Name corrected',
    });
    expect(ok.body.status).toBe('completed');
  });

  it('is isolated per organization', async () => {
    expect((await otherOwner.get(`/patients/${asha.id}`)).status).toBe(404);
    expect((await otherOwner.get('/patients?phone=9811100001')).body.data).toEqual([]);
    expect(
      (await otherOwner.post(`/patients/${asha.id}/consents`, { marketing: true })).status,
    ).toBe(404);
    const rows = await db.transaction(async (trx) => {
      await trx.raw("SELECT set_config('app.current_organization_id', ?, true)", [
        other.organization.id,
      ]);
      return trx('patients').select('id');
    });
    expect(rows).toEqual([]);
  });
});

describe('patient website: account, hospitals, family and booking', () => {
  const phone = '9822200001';
  let token;
  let cookie;
  let meera;
  let mother;
  const portal = (url) => `/api/v1/public/clinics/${t.organization.slug}${url}`;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('shows the hospital, its branches and the published notice', async () => {
    const r = await request(app).get(portal(''));
    expect(r.body.organization.name).toBe(t.organization.name);
    expect(r.body.privacyNotice.version).toBe('2026.1');
    expect((await request(app).get('/api/v1/public/clinics/no-such-clinic')).status).toBe(404);
  });

  it('signs in with phone + OTP and stays signed in with a rotating cookie', async () => {
    await request(app).post('/api/v1/patient-auth/otp/request').send({ phone }).expect(202);
    const bad = await request(app)
      .post('/api/v1/patient-auth/otp/verify')
      .send({ phone, code: '000000' });
    expect(bad.status).toBe(400);
    const ok = await request(app)
      .post('/api/v1/patient-auth/otp/verify')
      .send({ phone, code: sms.lastCodeFor('+919822200001') });
    token = ok.body.accessToken;
    cookie = ok.headers['set-cookie'][0].split(';')[0];
    expect(token).toBeTruthy();
    // patient tokens never work on staff APIs, and staff tokens never work on patient APIs
    expect((await request(app).get('/api/v1/patients').set(auth())).status).toBe(401);
    const staffToken = (await login(app, t.owner.email)).token;
    expect((await request(app).get('/api/v1/patient/me').set(bearer(staffToken))).status).toBe(401);

    const refreshed = await request(app)
      .post('/api/v1/patient-auth/refresh')
      .set(CSRF)
      .set('Cookie', cookie);
    expect(refreshed.status).toBe(200);
    const newCookie = refreshed.headers['set-cookie'][0].split(';')[0];
    // reusing the old refresh cookie ends every session (stolen-token protection)
    const reuse = await request(app)
      .post('/api/v1/patient-auth/refresh')
      .set(CSRF)
      .set('Cookie', cookie);
    expect(reuse.status).toBe(401);
    expect(
      (await request(app).post('/api/v1/patient-auth/refresh').set(CSRF).set('Cookie', newCookie))
        .status,
    ).toBe(401);
  });

  it('joins a hospital once with its code', async () => {
    expect((await request(app).get(portal('/me')).set(auth())).status).toBe(403);
    const wrong = await request(app)
      .post('/api/v1/patient/clinics')
      .set(auth())
      .send({ code: 'nope-xyz' });
    expect(wrong.status).toBe(404);
    const join = await request(app)
      .post('/api/v1/patient/clinics')
      .set(auth())
      .send({ code: t.organization.slug.toUpperCase() });
    expect(join.status).toBe(201);
    const me = await request(app).get('/api/v1/patient/me').set(auth());
    expect(me.body.clinics.map((c) => c.code)).toEqual([t.organization.slug]);
  });

  it('self registration is authorized; family members wait for staff authorization', async () => {
    const self = await request(app)
      .post(portal('/patients'))
      .set(auth())
      .send({
        fullName: 'Meera Nair',
        dateOfBirth: '1985-02-02',
        relationship: 'self',
        privacyNoticeAcknowledged: true,
        consents: { whatsappService: true },
      });
    expect(self.body).toMatchObject({ authorizationStatus: 'authorized' });
    meera = self.body;
    mother = (
      await request(app).post(portal('/patients')).set(auth()).send({
        fullName: 'Lata Nair',
        dateOfBirth: '1958-09-09',
        relationship: 'parent',
        privacyNoticeAcknowledged: true,
      })
    ).body;
    expect(mother).toMatchObject({ authorizationStatus: 'pending', patientNumber: null });

    const again = await request(app).post(portal('/patients')).set(auth()).send({
      fullName: 'Meera Nair',
      dateOfBirth: '1985-02-02',
      relationship: 'self',
      privacyNoticeAcknowledged: true,
    });
    expect(again.body.error.code).toBe('ALREADY_REGISTERED');

    const me = await request(app).get(portal('/me')).set(auth());
    expect(me.body.patients.map((p) => [p.fullName, p.authorizationStatus])).toEqual([
      ['Meera Nair', 'authorized'],
      ['Lata Nair', 'pending'],
    ]);
    expect(
      (
        await request(app)
          .post(portal(`/patients/${mother.id}/consents`))
          .set(auth())
          .send({ smsService: true })
      ).status,
    ).toBe(404);

    const pending = await reception.get('/patients/links/pending');
    const link = pending.body.data.find((l) => l.patient.id === mother.id);
    expect(link.phoneVerified).toBe(true);
    await reception.post(`/patients/${mother.id}/contacts/${link.linkId}/authorize`);
    const consent = await request(app)
      .post(portal(`/patients/${mother.id}/consents`))
      .set(auth())
      .send({ smsService: true });
    expect(consent.body.patients[1].consents.sms_service.status).toBe('granted');
  });

  it('books, tracks and cancels online for authorized family members only', async () => {
    const doc = (
      await owner.post('/doctors', { displayName: 'Dr. Portal Test', branchId: t.branch.id })
    ).body;
    await owner.put(`/doctors/${doc.id}/schedule`, {
      sessions: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
        dayOfWeek: d,
        startTime: '09:00',
        endTime: '12:00',
        slotMinutes: 15,
      })),
    });
    const doctors = await request(app).get(portal('/doctors')).set(auth());
    expect(doctors.body.data.map((d) => d.name)).toContain('Dr. Portal Test');
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const slots = await request(app)
      .get(portal(`/doctors/${doc.id}/slots?date=${tomorrow}`))
      .set(auth());
    expect(slots.body.slots).toHaveLength(12);
    const book = (patientId, key) =>
      request(app)
        .post(portal('/appointments'))
        .set(auth())
        .set('Idempotency-Key', key)
        .send({ patientId, doctorId: doc.id, slotStart: slots.body.slots[0].start });
    const r = await book(meera.id, 'portal-key-001');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ token: 1, status: 'booked' });
    expect((await book(meera.id, 'portal-key-001')).status).toBe(200);
    // a patient registered by someone else (not linked to this phone) can't be booked
    const stranger = (await register({ fullName: 'Other Person', phone: '9811100077' })).body;
    expect((await book(stranger.id, 'portal-key-002')).status).toBe(404);

    const tracking = await request(app).get(`/api/v1/public/track/${r.body.trackingCode}`);
    expect(tracking.body.token).toBe(1);
    const cancelled = await request(app)
      .post(portal(`/appointments/${r.body.id}/cancel`))
      .set(auth());
    expect(cancelled.body.data.find((a) => a.id === r.body.id).status).toBe('cancelled');
  });

  it('a hospital the account has not joined is closed to it', async () => {
    const r = await request(app)
      .get(`/api/v1/public/clinics/${other.organization.slug}/me`)
      .set(auth());
    expect(r.status).toBe(403);
  });
});
