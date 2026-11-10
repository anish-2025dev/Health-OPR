import { AppError } from '../../core/errors.js';
import { addDays } from '../hr-attendance/calc.js';
import { localDate } from '../clinic/calc.js';
import { bookAppointment, loadDoctor, slotsFor, transition } from '../clinic/service.js';
import { recordConsents } from '../patients/service.js';
import { formatDay, formatTime, trackingLink } from '../notifications/index.js';

/**
 * WhatsApp self-service for EXISTING registered patients (spec):
 * - Never creates a patient profile. Unknown numbers and unregistered family members are sent to the
 *   patient website or the reception.
 * - Asks which authorized family member the appointment is for. Pending family links are not offered.
 * - Replies contain no medical details. "STOP" withdraws WhatsApp consent for this number's patients.
 *
 * The conversation is a small state machine stored in whatsapp_conversations. It expires after
 * 30 minutes of silence. All of it runs in the hospital's tenant transaction; replies are returned
 * and sent after commit.
 */
const IDLE_MINUTES = 30;
const MAX_OPTIONS = 9;
const MENU =
  'Reply with a number:\n1. Book an appointment\n2. My appointments\n3. Cancel an appointment\n\nReply MENU at any time to start again, or STOP to stop WhatsApp messages.';

const numbered = (items, label) => items.map((x, i) => `${i + 1}. ${label(x)}`).join('\n');
const pick = (text, list) => {
  const n = Number.parseInt(text, 10);
  return Number.isInteger(n) && n >= 1 && n <= list.length ? list[n - 1] : null;
};

export async function handleMessage(trx, ctx) {
  const { org, phone, text: raw, messageId, config } = ctx;
  const text = String(raw ?? '').trim();
  const lower = text.toLowerCase();
  const portalLink = `${config.PATIENT_SITE_URL.replace(/\/$/, '')}/clinic/${org.slug}`;
  const save = (state, data = {}) =>
    trx('whatsapp_conversations')
      .insert({ organization_id: org.id, phone_e164: phone, state, data, updated_at: trx.fn.now() })
      .onConflict(['organization_id', 'phone_e164'])
      .merge();

  const contact = await trx('contacts')
    .where({ organization_id: org.id, phone_e164: phone })
    .first('id');
  const patients = contact
    ? await trx('contact_patient_links as l')
        .join('patients as p', 'p.id', 'l.patient_id')
        .where({
          'l.organization_id': org.id,
          'l.contact_id': contact.id,
          'l.authorization_status': 'authorized',
          'p.status': 'active',
        })
        .orderBy('l.created_at')
        .select('p.id', 'p.full_name', 'l.relationship')
    : [];
  if (!patients.length) {
    return [
      `Welcome to ${org.name}. We couldn't find a registered patient for this WhatsApp number, so we can't book here.\n\nPlease register at ${portalLink} or at the reception. After registering you can book on WhatsApp.`,
    ];
  }

  if (lower === 'stop') {
    for (const p of patients) {
      await recordConsents(
        trx,
        org.id,
        p.id,
        { whatsapp_service: false },
        {
          channel: 'whatsapp',
          source: 'whatsapp_stop_keyword',
          actingContactId: contact.id,
        },
      );
    }
    await save('menu');
    return [
      'You will no longer receive WhatsApp updates from us. You can turn them on again on the patient website or at the reception.',
    ];
  }

  const conv = await trx('whatsapp_conversations')
    .where({ organization_id: org.id, phone_e164: phone })
    .first();
  const fresh = !conv || Date.now() - new Date(conv.updated_at).getTime() > IDLE_MINUTES * 60_000;
  const state =
    fresh || ['menu', 'hi', 'hello', 'start', '0'].includes(lower) ? 'start' : conv.state;
  const data = fresh ? {} : (conv.data ?? {});

  const upcoming = async () =>
    trx('appointments as a')
      .join('patients as p', 'p.id', 'a.patient_id')
      .join('queue_entries as q', 'q.appointment_id', 'a.id')
      .where('a.organization_id', org.id)
      .whereIn(
        'a.patient_id',
        patients.map((p) => p.id),
      )
      .whereIn('a.status', ['booked', 'checked_in'])
      .orderBy('a.slot_start')
      .limit(MAX_OPTIONS)
      .select(
        'a.id',
        'a.appointment_date',
        'a.slot_start',
        'a.status',
        'p.full_name',
        'q.token_number',
        'q.tracking_code',
      );

  const askDoctor = async (patientId) => {
    const doctors = await trx('doctors')
      .where({ organization_id: org.id, status: 'active', online_booking_enabled: true })
      .orderBy('display_name')
      .limit(MAX_OPTIONS)
      .select('id', 'display_name');
    if (!doctors.length) {
      await save('menu');
      return ['Online booking is not available right now. Please call the reception.'];
    }
    await save('choose_doctor', { patientId, options: doctors.map((d) => d.id) });
    return [`Which doctor?\n${numbered(doctors, (d) => d.display_name)}`];
  };

  const askDate = async (patientId, doctorId) => {
    const doctor = await loadDoctor(trx, org.id, doctorId);
    const today = localDate(doctor.timezone);
    const days = [];
    for (let i = 0; i <= doctor.booking_window_days && days.length < 7; i++) {
      const date = addDays(today, i);
      const { slots } = await slotsFor(trx, org.id, doctor, date);
      if (slots.some((s) => s.available)) days.push(date);
    }
    if (!days.length) {
      await save('menu');
      return [
        `${doctor.display_name} has no free times in the booking window. Reply MENU to choose another doctor.`,
      ];
    }
    await save('choose_date', { patientId, doctorId, options: days });
    return [`Which day?\n${numbered(days, formatDay)}`];
  };

  switch (state) {
    case 'start':
      await save('menu');
      return [`Hello from ${org.name}.\n\n${MENU}`];

    case 'menu': {
      if (text === '1') {
        if (patients.length === 1) return askDoctor(patients[0].id);
        await save('choose_patient', { options: patients.map((p) => p.id) });
        return [
          `Who is the appointment for?\n${numbered(patients, (p) => p.full_name)}\n\nTo add a family member, use ${portalLink}`,
        ];
      }
      if (text === '2' || text === '3') {
        const list = await upcoming();
        if (!list.length) return [`You have no upcoming appointments.\n\n${MENU}`];
        if (text === '2') {
          return [
            list
              .map(
                (a) =>
                  `${a.full_name}: ${formatDay(a.appointment_date)} ${formatTime(a.slot_start)}, token ${a.token_number}\nLive status: ${trackingLink(config, a.tracking_code)}`,
              )
              .join('\n\n'),
          ];
        }
        const cancellable = list.filter((a) => a.status === 'booked');
        if (!cancellable.length)
          return [
            'These appointments can no longer be cancelled here. Please speak to the reception.',
          ];
        await save('choose_cancel', { options: cancellable.map((a) => a.id) });
        return [
          `Which appointment should be cancelled?\n${numbered(cancellable, (a) => `${a.full_name}, ${formatDay(a.appointment_date)} ${formatTime(a.slot_start)}`)}`,
        ];
      }
      return [MENU];
    }

    case 'choose_patient': {
      const id = pick(text, data.options ?? []);
      if (!id || !patients.some((p) => p.id === id))
        return ['Please reply with one of the numbers shown, or MENU.'];
      return askDoctor(id);
    }

    case 'choose_doctor': {
      const id = pick(text, data.options ?? []);
      if (!id) return ['Please reply with one of the numbers shown, or MENU.'];
      return askDate(data.patientId, id);
    }

    case 'choose_date': {
      const date = pick(text, data.options ?? []);
      if (!date) return ['Please reply with one of the numbers shown, or MENU.'];
      const doctor = await loadDoctor(trx, org.id, data.doctorId);
      const { slots } = await slotsFor(trx, org.id, doctor, date);
      const free = slots.filter((s) => s.available).slice(0, MAX_OPTIONS);
      if (!free.length) return askDate(data.patientId, data.doctorId);
      await save('choose_time', { ...data, date, options: free.map((s) => s.start) });
      return [`Which time on ${formatDay(date)}?\n${numbered(free, (s) => formatTime(s.start))}`];
    }

    case 'choose_time': {
      const start = pick(text, data.options ?? []);
      if (!start) return ['Please reply with one of the numbers shown, or MENU.'];
      const patient = patients.find((p) => p.id === data.patientId);
      const doctor = await loadDoctor(trx, org.id, data.doctorId);
      await save('confirm', { ...data, slotStart: start, options: [] });
      return [
        `Please confirm:\n${patient.full_name} with ${doctor.display_name}\n${formatDay(data.date)} at ${formatTime(start)}\n\nReply 1 to confirm or MENU to start again.`,
      ];
    }

    case 'confirm': {
      if (text !== '1') return ['Reply 1 to confirm or MENU to start again.'];
      if (!patients.some((p) => p.id === data.patientId)) {
        await save('menu');
        return [MENU];
      }
      try {
        const r = await bookAppointment(trx, org.id, {
          patientId: data.patientId,
          doctorId: data.doctorId,
          slotStart: data.slotStart,
          source: 'whatsapp',
          idempotencyKey: `whatsapp:${messageId}`,
          contactId: contact.id,
        });
        const q = await trx('queue_entries')
          .where({ organization_id: org.id, appointment_id: r.appointmentId })
          .first('token_number', 'tracking_code');
        await save('menu');
        return [
          `Booked. ${formatDay(data.date)} at ${formatTime(data.slotStart)}, token ${q.token_number}.\nFollow the live queue here: ${trackingLink(config, q.tracking_code)}\n\nReply MENU for more.`,
        ];
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        if (err.code === 'SLOT_FULL') {
          await save('menu');
          return [`Sorry, that time was just taken. Reply 1 to choose another time.`];
        }
        await save('menu');
        return [`Sorry, we couldn't book this: ${err.message}\n\n${MENU}`];
      }
    }

    case 'choose_cancel': {
      const id = pick(text, data.options ?? []);
      if (!id) return ['Please reply with one of the numbers shown, or MENU.'];
      const entry = await trx('queue_entries')
        .join('appointments as a', 'a.id', 'queue_entries.appointment_id')
        .where({ 'queue_entries.organization_id': org.id, 'a.id': id, 'a.status': 'booked' })
        .whereIn(
          'a.patient_id',
          patients.map((p) => p.id),
        )
        .forUpdate()
        .first('queue_entries.*');
      await save('menu');
      if (!entry) return [`That appointment can't be cancelled any more.\n\n${MENU}`];
      await transition(trx, org.id, entry, 'cancel', {
        reason: 'Cancelled by patient on WhatsApp',
      });
      return [`Your appointment is cancelled.\n\n${MENU}`];
    }

    default:
      await save('menu');
      return [MENU];
  }
}
