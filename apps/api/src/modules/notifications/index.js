import { withTenant } from '../../core/db.js';
import { communicationAllowed } from '../patients/service.js';
import { SmsNotConfiguredError } from '../../integrations/sms/index.js';
import { WhatsAppNotConfiguredError } from '../../integrations/whatsapp/index.js';

const TZ = 'Asia/Kolkata';
export const formatDay = (date) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
export const formatTime = (iso) =>
  new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: TZ,
  });
export const trackingLink = (config, code) =>
  `${config.PATIENT_SITE_URL.replace(/\/$/, '')}/track/${code}`;

/**
 * Patient notifications (spec):
 * - Generic text with a secure link: hospital name, date, time, token and the tracking link. Never the
 *   doctor's specialty, reason for visit or any medical detail.
 * - Sent only with the patient's current consent for that channel: WhatsApp first, then SMS. Withdrawn
 *   consent stops future messages.
 * - Each attempt is logged (channel and status only) in notification_log.
 * Runs after the booking transaction commits; a failure never undoes the booking.
 */
export function createNotifier({ db, config, whatsapp, sms, logger }) {
  async function log(trx, row) {
    await trx('notification_log').insert(row);
  }

  const inFlight = new Set();
  const track = (p) => {
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
    return p;
  };

  return {
    /** Waits for queued notifications (tests and graceful shutdown). */
    async drain() {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    },
    appointmentBooked(organizationId, appointmentId) {
      return track(this.sendAppointmentBooked(organizationId, appointmentId));
    },
    async sendAppointmentBooked(organizationId, appointmentId) {
      try {
        await withTenant(db, organizationId, async (trx) => {
          const a = await trx('appointments as a')
            .join('organizations as o', 'o.id', 'a.organization_id')
            .join('queue_entries as q', 'q.appointment_id', 'a.id')
            .where({ 'a.organization_id': organizationId, 'a.id': appointmentId })
            .first(
              'a.id',
              'a.patient_id',
              'a.appointment_date',
              'a.slot_start',
              'a.booked_by_contact_id',
              'o.name as org_name',
              'q.token_number',
              'q.tracking_code',
            );
          if (!a) return;
          const base = {
            organization_id: organizationId,
            patient_id: a.patient_id,
            appointment_id: a.id,
            purpose: 'appointment_booked',
          };
          // Prefer the person who booked, then the patient's own number, then any authorized contact.
          const links = await trx('contact_patient_links as l')
            .join('contacts as c', 'c.id', 'l.contact_id')
            .where({
              'l.organization_id': organizationId,
              'l.patient_id': a.patient_id,
              'l.authorization_status': 'authorized',
            })
            .select('c.id', 'c.phone_e164', 'l.relationship');
          const contact =
            links.find((l) => l.id === a.booked_by_contact_id) ??
            links.find((l) => l.relationship === 'self') ??
            links[0];
          if (!contact)
            return log(trx, {
              ...base,
              channel: 'none',
              status: 'skipped',
              reason: 'no authorized contact',
            });

          const variables = {
            token: a.token_number,
            date: formatDay(a.appointment_date),
            time: formatTime(a.slot_start),
            link: trackingLink(config, a.tracking_code),
          };
          const channel = await trx('whatsapp_channels')
            .where({ organization_id: organizationId, status: 'active' })
            .first('phone_number_id');
          const reasons = [];

          if (await communicationAllowed(trx, organizationId, a.patient_id, 'whatsapp')) {
            if (!channel) reasons.push('whatsapp: hospital number not set up');
            else if (!config.WHATSAPP_APPOINTMENT_TEMPLATE)
              reasons.push('whatsapp: template not set');
            else {
              try {
                await whatsapp.sendTemplate({
                  phoneNumberId: channel.phone_number_id,
                  to: contact.phone_e164,
                  template: config.WHATSAPP_APPOINTMENT_TEMPLATE,
                  language: config.WHATSAPP_TEMPLATE_LANGUAGE,
                  params: [variables.token, variables.date, variables.time, variables.link],
                });
                return log(trx, { ...base, channel: 'whatsapp', status: 'sent' });
              } catch (err) {
                reasons.push(
                  err instanceof WhatsAppNotConfiguredError
                    ? 'whatsapp: not configured'
                    : 'whatsapp: send failed',
                );
                if (!(err instanceof WhatsAppNotConfiguredError))
                  logger?.warn({ err: err.message }, 'whatsapp notification failed');
              }
            }
          } else reasons.push('whatsapp: no consent');

          if (await communicationAllowed(trx, organizationId, a.patient_id, 'sms')) {
            try {
              await sms.sendAppointment({ to: contact.phone_e164, variables });
              return log(trx, { ...base, channel: 'sms', status: 'sent' });
            } catch (err) {
              const notSet = err instanceof SmsNotConfiguredError;
              if (!notSet) logger?.warn({ err: err.message }, 'sms notification failed');
              return log(trx, {
                ...base,
                channel: 'sms',
                status: notSet ? 'skipped' : 'failed',
                reason: [...reasons, notSet ? 'sms: not configured' : 'sms: send failed'].join(
                  '; ',
                ),
              });
            }
          }
          reasons.push('sms: no consent');
          return log(trx, {
            ...base,
            channel: 'none',
            status: 'skipped',
            reason: reasons.join('; '),
          });
        });
      } catch (err) {
        logger?.error({ err: err.message }, 'appointment notification error');
      }
    },
  };
}
