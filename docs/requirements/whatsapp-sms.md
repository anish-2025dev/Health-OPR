# WhatsApp and SMS (Phase 6)

## What patients can do on WhatsApp

Patients who are **already registered** on a phone number can message the hospital's WhatsApp number to:

1. **Book.** If several family members share the number, they are first asked who the appointment
   is for. Then they choose a doctor, a day (the next days with free times) and a time, and confirm.
   The reply gives the token and a live-status link.
2. **See upcoming appointments**, with live-status links.
3. **Cancel** an appointment that has not started.

4. **See family members** registered on the number: names and patient numbers, or "awaiting the
   hospital's check". No other personal details.
5. **Register** themselves or a family member (see below).

`MENU` starts again. `STOP` withdraws WhatsApp consent for that number's patients. A conversation
resets after 30 minutes of silence.

### Registering on WhatsApp ([ADR 0010](../adr/0010-whatsapp-registration.md))

A number with no registered patient is offered "Reply 1 to register here on WhatsApp". The steps:

1. The patient reads the privacy notice and replies YES.
2. They say who they are registering: themselves or a family member (and the relationship).
3. They give the full name. It is tidied: "ravi KUMAR" becomes "Ravi Kumar".
4. They give the date of birth (15-08-1990, 15/8/1990 or 1990-08-15).
5. They give the gender.
6. They answer whether to send WhatsApp updates, and whether to send health camps and offers.
7. They confirm.

The first "self" profile is active at once and gets a patient number. Family members wait for the
hospital's check before they can be booked. The same person is never added twice on one number.

Rules (spec):

- WhatsApp creates a patient **only** through the registration steps above (privacy notice
  acknowledgement first). It never creates one from a booking message.
- Only **authorized** family links are offered. Family members still awaiting the hospital's check
  are not.
- No medical details in any message.

## Appointment confirmations

After a booking made at reception or on the patient website, the patient gets a confirmation (WhatsApp
bookings are confirmed in the chat):

1. WhatsApp **template**, if the patient's current WhatsApp consent is "yes", the hospital's number is
   registered and the server has an approved template (`WHATSAPP_APPOINTMENT_TEMPLATE`, four body
   parameters: token, date, time, link).
2. Otherwise **SMS**, if SMS consent is "yes" and `MSG91_APPOINTMENT_TEMPLATE_ID` is set.
3. Otherwise nothing.

Each attempt is logged in `notification_log` with the channel, status and reason (never message text).
Admins see it under **WhatsApp & SMS**. A failed message never undoes a booking.

## Webhook

- `GET /api/v1/webhooks/whatsapp` answers Meta's subscription handshake with `WHATSAPP_VERIFY_TOKEN`.
- `POST /api/v1/webhooks/whatsapp` verifies `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with
  `WHATSAPP_APP_SECRET`). Incoming messages are matched to a hospital by **phone number ID** and stored
  with the provider's message ID (unique, so repeated deliveries are ignored). The webhook acknowledges
  with 200 straight away and processing runs in the background. Events left unprocessed (for example
  after a restart) are retried every minute. Message text is cleared once handled.
- Booking from WhatsApp uses the message ID as the idempotency key.

## Setting it up (per deployment)

1. In Meta Business: create a WhatsApp Business account, add a phone number for each hospital, and
   create a system-user access token.
2. Create and get approval for an appointment-confirmation **template** with four body parameters
   (token, date, time, link) and no medical wording.
3. On the API service, set `WHATSAPP_PROVIDER=meta`, `WHATSAPP_ACCESS_TOKEN`,
   `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_GRAPH_API_VERSION` (as shown in your
   Meta app) and `WHATSAPP_APPOINTMENT_TEMPLATE`.
4. In the Meta app, subscribe the webhook `https://<api host>/api/v1/webhooks/whatsapp` (messages
   field) with the same verify token.
5. In HealthOS, each hospital owner/admin enters their number's **Phone number ID** under
   **WhatsApp & SMS**.

Use only provider IDs and template names from your own Meta account. None are bundled with the app.

## API

| Endpoint                                                    | Purpose                                              |
| ----------------------------------------------------------- | ---------------------------------------------------- |
| `GET /integrations/whatsapp` · `PUT /integrations/whatsapp` | Hospital number settings (`organization.manage`)     |
| `GET /integrations/notifications`                           | Recent confirmation outcomes (`organization.manage`) |
