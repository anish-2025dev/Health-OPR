export const RELATIONSHIPS = [
  ['self', 'Self (phone owner)'],
  ['parent', 'Parent'],
  ['child', 'Child'],
  ['spouse', 'Spouse'],
  ['sibling', 'Sibling'],
  ['guardian', 'Guardian'],
  ['caregiver', 'Caregiver'],
  ['other', 'Other'],
];
export const RELATIONSHIP_LABEL = Object.fromEntries(RELATIONSHIPS);

export const CONSENT_LABEL = {
  privacy_notice: 'Privacy notice acknowledged',
  whatsapp_service: 'WhatsApp service messages',
  sms_service: 'SMS service messages',
  marketing: 'Marketing messages',
};

export const CONSENT_TONE = { granted: 'green', withdrawn: 'red', not_given: 'slate' };
export const CONSENT_STATUS = { granted: 'Yes', withdrawn: 'Withdrawn', not_given: 'Not given' };

export const GENDER_LABEL = {
  female: 'Female',
  male: 'Male',
  other: 'Other',
  undisclosed: 'Prefer not to say',
};

export const REQUEST_TYPE_LABEL = {
  access: 'Access to data',
  correction: 'Correction',
  erasure: 'Erasure',
  grievance: 'Grievance',
  nomination: 'Nomination',
};

export function age(dob) {
  if (!dob) return null;
  const [y, m, d] = dob.split('-').map(Number);
  const now = new Date();
  let years = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) years -= 1;
  return years;
}

export const formatDate = (iso) =>
  iso
    ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';
