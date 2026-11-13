import { AppError } from '../../core/errors.js';
import {
  RELATIONSHIPS,
  publishedNotice,
  selfRegister,
  upsertContact,
} from '../patients/service.js';

/**
 * Registration on WhatsApp (ADR 0010).
 *
 * The person reads the hospital's published privacy notice and agrees, then gives name, date of birth
 * and gender, says who they are registering, and makes their message choices. The same rules as the
 * patient website apply (patients/service.js selfRegister):
 * - the first "self" profile on the number is active; family members wait for the hospital's check;
 * - the same person is never registered twice on one number, whatever the capitals or spacing;
 * - possible duplicates elsewhere are flagged for staff, never merged.
 * The WhatsApp number itself is verified by WhatsApp, so the contact is marked verified.
 */
const FAMILY = RELATIONSHIPS.filter((r) => r !== 'self');
const FAMILY_LABEL = {
  parent: 'Parent',
  child: 'Child',
  spouse: 'Spouse',
  sibling: 'Brother or sister',
  guardian: 'Guardian',
  caregiver: 'Person I care for',
  other: 'Other relative',
};
const GENDERS = [
  ['female', 'Female'],
  ['male', 'Male'],
  ['other', 'Other'],
  ['undisclosed', 'Prefer not to say'],
];
const MAX_NOTICE = 2500;

/**
 * Tidies a typed name: spaces collapsed; each word typed all in lower or all in upper case is
 * capitalised ("ravi KUMAR" -> "Ravi Kumar"); mixed-case words such as "McDonald" stay as typed.
 */
export function cleanName(raw) {
  const name = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length < 2 || name.length > 100 || !/\p{L}/u.test(name) || /\d/.test(name)) return null;
  return name
    .split(' ')
    .map((word) =>
      word === word.toLowerCase() || word === word.toUpperCase()
        ? word.toLowerCase().replace(/(^|['-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
        : word,
    )
    .join(' ');
}

/** Accepts 15-08-1990, 15/8/1990, 15.08.1990 or 1990-08-15. Returns YYYY-MM-DD or null. */
export function parseDob(raw, today = new Date().toISOString().slice(0, 10)) {
  const t = String(raw ?? '').trim();
  let d;
  let m;
  let y;
  let match = t.match(/^(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{4})$/);
  if (match) [, d, m, y] = match;
  else if ((match = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [, y, m, d] = match;
  else return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return null;
  if (iso > today || Number(y) < 1900) return null;
  return iso;
}

const pick = (text, n) => {
  const v = Number.parseInt(text, 10);
  return Number.isInteger(v) && v >= 1 && v <= n ? v : null;
};

/** First message of a registration: the privacy notice. Returns replies, or null if not possible. */
export async function startRegistration(trx, { org, save, portalLink }, { forFamily }) {
  const notice = await publishedNotice(trx, org.id);
  if (!notice) {
    await save('menu');
    return [
      `Registration on WhatsApp isn't open yet. Please register at the reception or at ${portalLink}`,
    ];
  }
  await save('reg_notice', { reg: { forFamily } });
  const content =
    notice.content.length > MAX_NOTICE
      ? `${notice.content.slice(0, MAX_NOTICE)}…\n\nFull notice: ${portalLink}`
      : notice.content;
  return [
    `Before registering, please read how ${org.name} uses your information:\n\n*${notice.title}* (version ${notice.version})\n\n${content}`,
    'Reply YES if you have read it and agree, or MENU to stop.',
  ];
}

/** Continues a registration in progress. `state` starts with "reg_". */
export async function continueRegistration(trx, ctx, state, data) {
  const { org, phone, text, save, menu } = ctx;
  const reg = data.reg ?? {};
  const lower = text.toLowerCase();

  switch (state) {
    case 'reg_notice': {
      if (!['yes', 'y', 'i agree', 'agree'].includes(lower))
        return ['Reply YES to agree to the privacy notice, or MENU to stop.'];
      if (reg.forFamily) {
        await save('reg_relationship', { reg });
        return [
          `Who are you registering?\n${FAMILY.map((r, i) => `${i + 1}. ${FAMILY_LABEL[r]}`).join('\n')}`,
        ];
      }
      await save('reg_who', { reg });
      return ['Who are you registering?\n1. Myself\n2. A family member'];
    }
    case 'reg_who': {
      const n = pick(text, 2);
      if (!n) return ['Please reply 1 (myself) or 2 (a family member).'];
      if (n === 1) {
        await save('reg_name', { reg: { ...reg, relationship: 'self' } });
        return ['What is your full name?'];
      }
      await save('reg_relationship', { reg });
      return [
        `How are they related to you?\n${FAMILY.map((r, i) => `${i + 1}. ${FAMILY_LABEL[r]}`).join('\n')}`,
      ];
    }
    case 'reg_relationship': {
      const n = pick(text, FAMILY.length);
      if (!n) return ['Please reply with one of the numbers shown.'];
      await save('reg_name', { reg: { ...reg, relationship: FAMILY[n - 1] } });
      return ['What is their full name?'];
    }
    case 'reg_name': {
      const name = cleanName(text);
      if (!name) return ['Please type the full name using letters only (for example: Asha Verma).'];
      await save('reg_dob', { reg: { ...reg, fullName: name } });
      return [`Date of birth of ${name}? (for example 15-08-1990)`];
    }
    case 'reg_dob': {
      const dob = parseDob(text);
      if (!dob) return ['Please send the date of birth as day-month-year, for example 15-08-1990.'];
      await save('reg_gender', { reg: { ...reg, dateOfBirth: dob } });
      return [`Gender?\n${GENDERS.map(([, l], i) => `${i + 1}. ${l}`).join('\n')}`];
    }
    case 'reg_gender': {
      const n = pick(text, GENDERS.length);
      if (!n) return ['Please reply with one of the numbers shown.'];
      await save('reg_whatsapp', { reg: { ...reg, gender: GENDERS[n - 1][0] } });
      return ['May we send appointment updates for this person on WhatsApp?\n1. Yes\n2. No'];
    }
    case 'reg_whatsapp': {
      const n = pick(text, 2);
      if (!n) return ['Please reply 1 (yes) or 2 (no).'];
      await save('reg_marketing', { reg: { ...reg, whatsappService: n === 1 } });
      return ['Would they like to hear about health camps and offers? (optional)\n1. Yes\n2. No'];
    }
    case 'reg_marketing': {
      const n = pick(text, 2);
      if (!n) return ['Please reply 1 (yes) or 2 (no).'];
      const next = { ...reg, marketing: n === 1 };
      await save('reg_confirm', { reg: next });
      const [d, m, y] = [
        next.dateOfBirth.slice(8),
        next.dateOfBirth.slice(5, 7),
        next.dateOfBirth.slice(0, 4),
      ];
      return [
        `Please check:\nName: ${next.fullName}\nDate of birth: ${d}-${m}-${y}\nWho: ${next.relationship === 'self' ? 'You' : FAMILY_LABEL[next.relationship]}\nWhatsApp updates: ${next.whatsappService ? 'Yes' : 'No'}\n\nReply 1 to register or MENU to start again.`,
      ];
    }
    case 'reg_confirm': {
      if (text !== '1') return ['Reply 1 to register or MENU to start again.'];
      const contact = await upsertContact(trx, org.id, phone, { verified: true });
      try {
        const r = await selfRegister(
          trx,
          org.id,
          contact,
          {
            fullName: reg.fullName,
            dateOfBirth: reg.dateOfBirth,
            gender: reg.gender,
            relationship: reg.relationship,
            consents: {
              whatsappService: reg.whatsappService,
              smsService: false,
              marketing: reg.marketing,
            },
          },
          { channel: 'whatsapp', source: 'whatsapp_registration' },
        );
        await save('menu');
        if (r.authorizationStatus === 'authorized') {
          return [`Registered. ${r.fullName}'s patient number is ${r.patientNumber}.\n\n${menu}`];
        }
        return [
          `${r.fullName} is registered. The hospital will confirm your relationship at your next visit; after that you can book for them here.\n\n${menu}`,
        ];
      } catch (err) {
        if (err instanceof AppError && err.code === 'ALREADY_REGISTERED') {
          await save('menu');
          return [
            `${reg.fullName} is already registered on this number, so nothing new was created.\n\n${menu}`,
          ];
        }
        throw err;
      }
    }
    default:
      await save('menu');
      return [menu];
  }
}

/** "4. My family members": names and patient numbers only, never other personal details. */
export async function familyList(trx, { org, contact }) {
  const rows = contact
    ? await trx('contact_patient_links as l')
        .join('patients as p', 'p.id', 'l.patient_id')
        .where({ 'l.organization_id': org.id, 'l.contact_id': contact.id, 'p.status': 'active' })
        .whereNot('l.authorization_status', 'revoked')
        .orderBy('l.created_at')
        .select('p.full_name', 'p.patient_number', 'l.relationship', 'l.authorization_status')
    : [];
  if (!rows.length) return 'Nobody is registered on this number yet.';
  const lines = rows.map(
    (r, i) =>
      `${i + 1}. ${r.full_name} (${r.relationship === 'self' ? 'You' : FAMILY_LABEL[r.relationship]}) — ${
        r.authorization_status === 'authorized' ? r.patient_number : "awaiting the hospital's check"
      }`,
  );
  return `Registered on this number:\n${lines.join('\n')}\n\nTo correct any details, please ask at the reception.`;
}
