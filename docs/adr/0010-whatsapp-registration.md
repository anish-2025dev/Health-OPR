# ADR 0010: Patient registration on WhatsApp

- Status: Accepted (product owner decision, 2026-11-13)
- Date: 2026-11-13

## Context

The original requirements said WhatsApp must never create patient profiles: new people were sent to
the patient website or the reception. The product owner asked for patients to be able to register on
WhatsApp too (for example after scanning a "chat with us" QR code), and to see which family members
are registered on their number.

## Decision

Registration on WhatsApp is allowed, with the same safeguards as the patient website:

1. **Privacy notice first.** The hospital's published notice (title, version and text) is sent, and the
   person must reply YES. The acknowledgement is recorded with the notice version and channel
   `whatsapp`. Without a published notice, WhatsApp registration is unavailable.
2. **The WhatsApp number is the verified contact.** WhatsApp has already verified it. A phone number
   is still a contact, not an identity.
3. **Self versus family.** The first "self" profile on a number becomes active at once. Family members
   registered on WhatsApp wait for the hospital's check, exactly as on the website. Pending people
   cannot be booked.
4. **No duplicates on the same number.** The same name, ignoring capitals, spacing, punctuation and
   titles, with the same date of birth is not created twice. Possible duplicates elsewhere in the
   hospital are flagged for staff review and never merged automatically.
5. **Consent per purpose.** WhatsApp updates and marketing are asked separately. SMS stays off unless
   given later.
6. **Minimal details.** Name, date of birth and gender only. "My family members" lists names and
   patient numbers, never dates of birth or other details. Corrections go through the reception.

## Consequences

- New patients can start entirely on WhatsApp. Reception still checks family relationships.
- Message text in WhatsApp is held only while the conversation is processed (see the WhatsApp docs).
- Legal review of the notice and consent wording on WhatsApp is still required before real data.
