import { z } from 'zod';

/**
 * Normalizes a mobile number to E.164. Accepts Indian 10-digit mobiles (with or without 0/91 prefix)
 * and international numbers that already start with '+'. Spaces, dashes and brackets are ignored.
 * Returns null when the input can't be a valid number.
 */
export function normalizeMobile(input) {
  if (typeof input !== 'string') return null;
  const raw = input.replace(/[\s\-().]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(raw)) return raw;
  const digits = raw.replace(/^0+/, '');
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
  return null;
}

export const mobileSchema = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const normalized = normalizeMobile(v);
    if (!normalized) {
      ctx.addIssue({
        code: 'custom',
        message: 'Enter a valid mobile number (10-digit Indian mobile or +country code)',
      });
      return z.NEVER;
    }
    return normalized;
  });

/** Shows only the last 4 digits, e.g. "+91 ••••••3210". */
export function maskMobile(e164) {
  if (!e164) return null;
  const country = e164.startsWith('+91') ? '+91 ' : '+';
  return `${country}${'•'.repeat(6)}${e164.slice(-4)}`;
}
