import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addUser, bearer, createTenant, login, setupTestApp, sys } from './helpers.js';

// Fictional people only.
const { app, db, whatsapp, config } = setupTestApp();
const PHONE_NUMBER_ID = '1098765432101';
const FAMILY = '+919833300001';
let t;
let other;
let owner;
let reception;
let asha;
let kabir;
let doctor;
let seq = 0;

const api = (token) => ({
  get: (url) => request(app).get(`/api/v1${url}`).set(bearer(token)),
  post: (url, body = {}) => request(app).post(`/api/v1${url}`).set(bearer(token)).send(body),
  put: (url, body) => request(app).put(`/api/v1${url}`).set(bearer(token)).send(body),
});

function payload(from, text, id) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              messages: [{ id, from: from.replace('+', ''), type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}

async function deliver(from, text, id = `wamid.test.${++seq}`) {
  const body = JSON.stringify(payload(from, text, id));
  const signature = `sha256=${createHmac('sha256', config.WHATSAPP_APP_SECRET).update(body).digest('hex')}`;
  const res = await request(app)
    .post('/api/v1/webhooks/whatsapp')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signature)
    .send(body);
  expect(res.status).toBe(200);
  await app.locals.whatsappProcessor.drain();
  return whatsapp.lastTo(from)?.text ?? '';
}

beforeAll(async () => {
  t = await createTenant(db, 'wa');
  other = await createTenant(db, 'wab');
  owner = api((await login(app, t.owner.email)).token);
  reception = api(
    (await login(app, (await addUser(db, t.organization.id, ['receptionist'], 'rec')).email)).token,
  );
  const notice = await owner.post('/privacy/notices', {
    version: '1',
    title: 'Notice for tests',
    content: 'Placeholder privacy notice text for tests only.',
  });
  await owner.post(`/privacy/notices/${notice.body.id}/publish`);
  const reg = (body) =>
    reception.post('/patients', {
      branchId: t.branch.id,
      privacyNoticeAcknowledged: true,
      ...body,
    });
  asha = (
    await reg({
      fullName: 'Asha Kumar',
      dateOfBirth: '1990-01-01',
      phone: FAMILY,
      consents: { whatsappService: true },
    })
  ).body;
  kabir = (
    await reg({
      fullName: 'Kabir Kumar',
      dateOfBirth: '2017-05-05',
      phone: FAMILY,
      relationship: 'child',
    })
  ).body;
  doctor = (await owner.post('/doctors', { displayName: 'Dr. Wa Test', branchId: t.branch.id }))
    .body;
  await owner.put(`/doctors/${doctor.id}/schedule`, {
    sessions: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      dayOfWeek: d,
      startTime: '00:00',
      endTime: '23:55',
      slotMinutes: 5,
    })),
  });
});
afterAll(() => db.destroy());

describe('webhook security', () => {
  it('answers the subscription handshake only with the verify token', async () => {
    const ok = await request(app).get(
      '/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=12345',
    );
    expect(ok.text).toBe('12345');
    const bad = await request(app).get(
      '/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1',
    );
    expect(bad.status).toBe(403);
  });

  it('rejects unsigned or wrongly signed deliveries', async () => {
    const r = await request(app)
      .post('/api/v1/webhooks/whatsapp')
      .set('X-Hub-Signature-256', 'sha256=00')
      .send(payload(FAMILY, 'hi', 'x1'));
    expect(r.status).toBe(401);
  });

  it('only owners/admins register the hospital number, and a number belongs to one hospital', async () => {
    expect(
      (await reception.put('/integrations/whatsapp', { phoneNumberId: PHONE_NUMBER_ID })).status,
    ).toBe(403);
    const ok = await owner.put('/integrations/whatsapp', {
      phoneNumberId: PHONE_NUMBER_ID,
      displayPhone: '+91 80000 00000',
    });
    expect(ok.status).toBe(200);
    const otherOwner = api((await login(app, other.owner.email)).token);
    const taken = await otherOwner.put('/integrations/whatsapp', {
      phoneNumberId: PHONE_NUMBER_ID,
    });
    expect(taken.body.error.code).toBe('NUMBER_IN_USE');
  });
});

describe('WhatsApp self-service for registered patients', () => {
  it('never creates a profile for an unknown number; points to registration', async () => {
    const before = await sys(db, (x) =>
      x('patients').where({ organization_id: t.organization.id }).count({ n: '*' }).first(),
    );
    const reply = await deliver('+919833399999', 'hi, I want an appointment');
    expect(reply).toContain("couldn't find a registered patient");
    expect(reply).toContain(`https://patients.example.test/clinic/${t.organization.slug}`);
    const after = await sys(db, (x) =>
      x('patients').where({ organization_id: t.organization.id }).count({ n: '*' }).first(),
    );
    expect(after.n).toBe(before.n);
  });

  it('asks which family member, then books with a token and live link', async () => {
    expect(await deliver(FAMILY, 'hi')).toContain('1. Book an appointment');
    const who = await deliver(FAMILY, '1');
    expect(who).toContain('Who is the appointment for?');
    expect(who).toContain('1. Asha Kumar');
    expect(who).toContain('2. Kabir Kumar');
    expect(await deliver(FAMILY, '2')).toContain('1. Dr. Wa Test');
    expect(await deliver(FAMILY, '1')).toContain('Which day?');
    expect(await deliver(FAMILY, '2')).toContain('Which time');
    const confirm = await deliver(FAMILY, '1');
    expect(confirm).toContain('Kabir Kumar with Dr. Wa Test');
    const booked = await deliver(FAMILY, '1', 'wamid.confirm.1');
    expect(booked).toMatch(/Booked\..*token 1/s);
    expect(booked).toContain('https://patients.example.test/track/');
    expect(booked).not.toMatch(/Kabir|Asha/);

    // the same webhook delivered again does not book twice
    await deliver(FAMILY, '1', 'wamid.confirm.1');
    const appts = await sys(db, (x) =>
      x('appointments').where({ organization_id: t.organization.id, source: 'whatsapp' }),
    );
    expect(appts).toHaveLength(1);
    expect(appts[0].patient_id).toBe(kabir.id);
  });

  it('lists and cancels upcoming appointments', async () => {
    await deliver(FAMILY, 'menu');
    expect(await deliver(FAMILY, '2')).toContain('Kabir Kumar:');
    await deliver(FAMILY, 'menu');
    expect(await deliver(FAMILY, '3')).toContain('Which appointment should be cancelled?');
    expect(await deliver(FAMILY, '1')).toContain('cancelled');
    const appts = await sys(db, (x) =>
      x('appointments').where({ organization_id: t.organization.id, source: 'whatsapp' }),
    );
    expect(appts[0].status).toBe('cancelled');
  });

  it('pending family members are not offered', async () => {
    const contact = await sys(db, (x) =>
      x('contacts').where({ organization_id: t.organization.id, phone_e164: FAMILY }).first(),
    );
    const [grandma] = await sys(db, (x) =>
      x('patients')
        .insert({
          organization_id: t.organization.id,
          patient_number: 'P-WA-PEND',
          full_name: 'Pending Grandma',
          registration_source: 'portal',
        })
        .returning('id'),
    );
    await sys(db, (x) =>
      x('contact_patient_links').insert({
        organization_id: t.organization.id,
        contact_id: contact.id,
        patient_id: grandma.id,
        relationship: 'parent',
        authorization_status: 'pending',
        created_via: 'portal',
      }),
    );
    await deliver(FAMILY, 'menu');
    expect(await deliver(FAMILY, '1')).not.toContain('Pending Grandma');
  });
});

describe('appointment notifications', () => {
  const tomorrowSlot = async () => {
    const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    return (await reception.get(`/doctors/${doctor.id}/slots?date=${date}`)).body.slots.find(
      (s) => s.available,
    );
  };

  it('sends a WhatsApp template (no medical details) when the patient consented', async () => {
    whatsapp.clear();
    const slot = await tomorrowSlot();
    await reception.post('/appointments', {
      patientId: asha.id,
      doctorId: doctor.id,
      slotStart: slot.start,
    });
    await app.locals.notifier.drain();
    const msg = whatsapp.lastTo(FAMILY);
    expect(msg).toMatchObject({
      type: 'template',
      template: 'appointment_booked_test',
      phoneNumberId: PHONE_NUMBER_ID,
    });
    expect(msg.params).toHaveLength(4);
    expect(msg.params.join(' ')).not.toMatch(/Dr\.|Asha/);
    const log = await owner.get('/integrations/notifications');
    expect(log.body.data[0]).toMatchObject({ channel: 'whatsapp', status: 'sent' });
  });

  it('STOP withdraws WhatsApp consent; later bookings send nothing', async () => {
    expect(await deliver(FAMILY, 'STOP')).toContain('no longer receive WhatsApp updates');
    const p = await reception.get(`/patients/${asha.id}`);
    expect(p.body.consents.whatsapp_service.status).toBe('withdrawn');
    whatsapp.clear();
    const slot = await tomorrowSlot();
    await reception.post('/appointments', {
      patientId: kabir.id,
      doctorId: doctor.id,
      slotStart: slot.start,
    });
    await app.locals.notifier.drain();
    expect(whatsapp.sent.filter((m) => m.type === 'template')).toHaveLength(0);
    const log = await owner.get('/integrations/notifications');
    expect(log.body.data[0]).toMatchObject({ channel: 'none', status: 'skipped' });
  });

  it('is isolated per organization', async () => {
    const otherOwner = api((await login(app, other.owner.email)).token);
    expect((await otherOwner.get('/integrations/notifications')).body.data).toEqual([]);
    expect((await otherOwner.get('/integrations/whatsapp')).body.channel).toBeNull();
  });
});
