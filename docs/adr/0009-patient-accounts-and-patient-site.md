# ADR 0009: Patient accounts and a separate patient website

- Status: Accepted
- Date: 2026-11-10

## Context

Patients should be able to book online, follow their queue position from home, and come back later
without re-entering a hospital code. One person may visit several hospitals on the platform and
manage family members. The product owner asked for the patient website to have its own address, to
spread traffic and to manage it separately. In the future, the owner would like hospitals to see a
patient's history at other hospitals so they can make recommendations.

The spec says: a phone number is a contact channel, not a patient identity; patient profiles live in
each hospital's tenant data; OTP possession is not proof of authority over family members; and data
must never cross tenants.

## Decision

1. **Patient account = sign-in identity only.** `patient_accounts` holds one verified phone number.
   It is platform-level (not tenant-owned, like `organizations`) and holds no clinical or
   demographic data.
2. **Hospitals are joined explicitly.** The patient enters a hospital's code once, or opens the
   hospital's QR link, which carries the code. `patient_account_clinics` then links the account to
   that hospital's verified contact. Each hospital's patient records, consents, appointments and visit
   history stay inside that hospital's tenant. Every per-hospital request runs in `withTenant()` for
   that hospital after the membership check. There is no lookup "which hospitals know this phone",
   so the platform never reveals to anyone where a person is a patient.
3. **Separate tokens.** Patient access tokens have their own audience and key. Staff APIs reject
   them, and patient APIs reject staff tokens. A rotating HttpOnly refresh cookie
   (`hos_patient_refresh`, path `/api/v1/patient-auth`, default 30 days) keeps the patient signed in
   on the device. Reusing a rotated refresh token revokes every session of the account.
4. **Family authority is unchanged.** The first "self" profile on a verified phone is authorized.
   Other family members stay pending until hospital staff authorize the relationship, and pending
   patients cannot be booked or managed online.
5. **Separate website, one codebase.** `apps/web` builds two sites: the staff/employee app and,
   with `VITE_APP_SURFACE=patient`, the patient website (`dist-patient`). Each build contains only
   its own code. Render serves them as two static sites, both proxying `/api` to the same API.

## Cross-hospital history (future, not built)

Sharing a patient's history between hospitals is **not** implemented. Each hospital sees only its
own records. If it is built later, it must:

- be opt-in per patient and per receiving hospital, with a separate, purpose-specific consent record
  (for example "share my visit history with Hospital B for care recommendations"). The consent must
  be withdrawable, and withdrawal must stop further access;
- share only what the consent covers, through an explicit request/grant flow between tenants. It
  must never use a shared table or a cross-tenant query;
- authenticate the patient (OTP) at the moment of granting;
- log every access in both hospitals' audit logs;
- have qualified Indian legal review (DPDP Act and rules; health-data guidance) before release;
- consider ABDM/ABHA interoperability instead of a proprietary scheme.

## Consequences

- Patients sign in once per device and see all their hospitals in one place.
- Hospitals remain fully isolated. A compromised patient account exposes only the hospitals that
  account joined, and within those only the patients its phone is authorized for.
- The per-clinic QR flow from Phase 3 now uses patient accounts instead of a short-lived portal
  token. The separate portal OTP table was removed before release.
