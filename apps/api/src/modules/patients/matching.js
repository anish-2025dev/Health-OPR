/**
 * Possible-duplicate detection for patient registration (spec: configurable matching and staff review;
 * never merge automatically based only on phone number or name).
 *
 * The result is only a suggestion for staff. A shared phone number alone is never treated as a match:
 * families share numbers, so a shared contact only adds weight to a similar name.
 */

/** Lowercases, removes punctuation and honorifics, and collapses spaces. */
export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\b(mr|mrs|ms|miss|dr|shri|smt|kumari|master|baby)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(s) {
  const out = new Map();
  const text = ` ${s} `;
  for (let i = 0; i < text.length - 1; i++) {
    const g = text.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Sørensen–Dice similarity of character bigrams, 0..1; word order is ignored. */
export function nameSimilarity(a, b) {
  const x = normalizeName(a).split(' ').sort().join(' ');
  const y = normalizeName(b).split(' ').sort().join(' ');
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bx = bigrams(x);
  const by = bigrams(y);
  let overlap = 0;
  let total = 0;
  for (const [g, n] of bx) {
    overlap += Math.min(n, by.get(g) ?? 0);
    total += n;
  }
  for (const n of by.values()) total += n;
  return (2 * overlap) / total;
}

/**
 * Scores candidates against a new registration.
 * @param subject   { fullName, dateOfBirth|null, contactIds: string[] }
 * @param candidates [{ id, fullName, dateOfBirth|null, contactIds: string[] }]
 * @param settings  { nameSimilarityThreshold: number, matchRequiresDob: boolean }
 * @returns [{ patientId, score, reasons }] sorted by score, highest first
 */
export function findPossibleDuplicates(subject, candidates, settings) {
  const threshold = Number(settings.nameSimilarityThreshold);
  const out = [];
  for (const c of candidates) {
    const similarity = nameSimilarity(subject.fullName, c.fullName);
    if (similarity < threshold) continue;
    const sameDob = Boolean(subject.dateOfBirth && c.dateOfBirth === subject.dateOfBirth);
    const dobConflict = Boolean(
      subject.dateOfBirth && c.dateOfBirth && c.dateOfBirth !== subject.dateOfBirth,
    );
    const sharedContact = c.contactIds.some((id) => subject.contactIds.includes(id));
    if (dobConflict) continue; // different dates of birth: different people
    if (settings.matchRequiresDob && !sameDob && !sharedContact) continue;
    if (!sameDob && !sharedContact && !settings.matchRequiresDob && similarity < 1) continue;

    const reasons = [similarity === 1 ? 'same_name' : 'similar_name'];
    if (sameDob) reasons.push('same_date_of_birth');
    if (sharedContact) reasons.push('shared_contact');
    const score = Math.min(1, similarity * 0.6 + (sameDob ? 0.3 : 0) + (sharedContact ? 0.1 : 0));
    out.push({ patientId: c.id, score: Math.round(score * 1000) / 1000, reasons });
  }
  return out.sort((a, b) => b.score - a.score);
}
