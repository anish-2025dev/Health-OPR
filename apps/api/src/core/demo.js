/**
 * Demo sign-in codes (demo deployment only).
 *
 * When SMS_DEMO_CODES is on, sign-in and attendance codes for the DEMO hospital's fictional numbers
 * (+91 90000 00xxx, see scripts/seed-demo.js) are returned in the API response and shown on screen
 * instead of being sent by SMS. Real numbers and every other hospital always use real SMS.
 * Never switch this on for the pilot or production.
 */
export const DEMO_NUMBER = /^\+919000000\d{3}$/;
export const isDemoNumber = (phone) => typeof phone === 'string' && DEMO_NUMBER.test(phone);

export function demoCodesEnabled(config) {
  return Boolean(config.SMS_DEMO_CODES && config.DEMO_HOSPITAL_CODE);
}

/** Employee codes: only for the demo hospital and a demo number. */
export function demoCodeAllowed(config, organizationSlug, phone) {
  return (
    demoCodesEnabled(config) &&
    organizationSlug === config.DEMO_HOSPITAL_CODE &&
    isDemoNumber(phone)
  );
}
