import { randomBytes } from 'node:crypto';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import { z } from 'zod';

// Argon2id with the library defaults (m=19 MiB, t=2, p=1), which meet the OWASP minimum.
const OPTIONS = { algorithm: Algorithm.Argon2id };

export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters');

export const hashPassword = (password) => hash(password, OPTIONS);

export async function verifyPassword(passwordHash, password) {
  if (!passwordHash) return false;
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** Hash of a random value, verified against for unknown emails so response time doesn't reveal them. */
let dummyHashPromise;
export function dummyHash() {
  dummyHashPromise ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHashPromise;
}

/** Readable random temporary password (about 100 bits), shown once to the admin. */
export function generateTemporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(20);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}-${out.slice(15, 20)}`;
}
