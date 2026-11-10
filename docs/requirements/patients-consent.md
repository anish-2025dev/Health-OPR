# Patients, family links and consent (Phases 3–4)

## Rules (from the spec)

- A phone number is a **contact channel**, not a patient. One contact can link to several patients
  (`contact_patient_links`), each with a relationship and an authorization status.
- **OTP possession is not proof of authority** over someone else. On the public QR portal only the
  first "self" profile on a verified phone is authorized automatically. Family members stay `pending`
  until staff authorize the relationship. Pending patients cannot be booked or managed from the portal.
- **Duplicates are never merged automatically.** Registration checks name similarity (configurable
  threshold), date of birth and shared contacts. Reception sees possible matches and can open the
  existing record or confirm "not the same person". Every confirmed registration with matches creates
  a review item. A privacy manager can merge (one record is kept, the other is marked `merged`;
  nothing is deleted) or dismiss the item. The portal never reveals other records.
- **Consent** is stored as separate, append-only records per purpose: privacy notice acknowledgement,
  WhatsApp service messages, SMS service messages and marketing. Each record keeps the channel,
  capture source, acting contact and relationship, staff user and notice version. The newest record
  per purpose is the current state. Withdrawal adds a `withdrawn` record, and
  `communicationAllowed()` uses the current state for future messages.
- **Privacy notices** are versioned. The organization writes them (with its legal adviser; the app
  ships no legal text). Published versions are locked, and registration is blocked until one is
  published.
- **Data principal requests** (access, correction, erasure, grievance, nomination) can be raised at
  reception or on the portal and are tracked to a resolution. Timelines follow legal advice.

## Permissions

| Permission        | Granted to                                                |
| ----------------- | --------------------------------------------------------- |
| `patients.read`   | owner, admin, clinic manager, receptionist, doctor, nurse |
| `patients.manage` | owner, admin, clinic manager, receptionist                |
| `privacy.manage`  | owner, admin, clinic manager                              |

HR and payroll roles get no patient permissions. Users without `patients.manage` see masked phone
numbers and no email or address.

## API

Staff (Bearer access token):

| Endpoint group | Endpoints                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Patients       | `GET /patients?q=&phone=&status=` · `POST /patients` · `GET/PATCH /patients/:id`                                                                                                                                                                                         |
| Contact links  | `POST /patients/:id/contacts` · `POST /patients/:id/contacts/:linkId/authorize` · `POST /patients/:id/contacts/:linkId/revoke` · `GET /patients/links/pending`                                                                                                           |
| Consent        | `GET/POST /patients/:id/consents`                                                                                                                                                                                                                                        |
| Privacy        | `GET/POST /privacy/notices` · `PATCH/DELETE /privacy/notices/:id` · `POST /privacy/notices/:id/publish` · `GET/PUT /privacy/settings` · `GET /privacy/duplicates` · `POST /privacy/duplicates/:id/decide` · `GET/POST /privacy/requests` · `PATCH /privacy/requests/:id` |

Patient website (separate site; see ADR 0009). The QR page is `<patient site>/clinic/<org-code>`:

| Area         | Endpoints                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in      | `POST /patient-auth/otp/request` · `POST /patient-auth/otp/verify` (access token plus refresh cookie) · `POST /patient-auth/refresh` · `POST /patient-auth/logout`                                                              |
| Account      | `GET /patient/me` · `POST /patient/clinics` (join with the hospital code) · `DELETE /patient/clinics/:code`                                                                                                                     |
| One hospital | `GET /public/clinics/:slug` (public) · `GET /public/clinics/:slug/me` · `POST /public/clinics/:slug/patients` · `POST /public/clinics/:slug/patients/:id/consents` · `POST /public/clinics/:slug/patients/:id/privacy-requests` |
| Booking      | `GET /public/clinics/:slug/doctors` · `GET /public/clinics/:slug/doctors/:id/slots?date=` · `GET/POST /public/clinics/:slug/appointments` · `POST /public/clinics/:slug/appointments/:id/cancel`                                |

Patient tokens have their own audience and key, so staff APIs reject them and patient APIs reject
staff tokens. Per-hospital endpoints require the account to have joined that hospital.

## Pilot notes

- Patients are organization-wide: any branch can find them. The registering branch is recorded.
- Clinical notes are out of scope; patient records hold administrative data only.
