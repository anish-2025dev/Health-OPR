import { AppError, conflict } from '../../core/errors.js';
import { findPossibleDuplicates } from './matching.js';

export const RELATIONSHIPS = [
  'self',
  'parent',
  'child',
  'spouse',
  'sibling',
  'guardian',
  'caregiver',
  'other',
];
export const CONSENT_PURPOSES = ['privacy_notice', 'whatsapp_service', 'sms_service', 'marketing'];
/** Request body keys → consent purposes. */
export const CONSENT_KEYS = {
  privacyNotice: 'privacy_notice',
  whatsappService: 'whatsapp_service',
  smsService: 'sms_service',
  marketing: 'marketing',
};

export async function loadPatientSettings(trx, organizationId) {
  const row = await trx('patient_settings').where({ organization_id: organizationId }).first();
  return {
    nameSimilarityThreshold: Number(row?.name_similarity_threshold ?? 0.85),
    matchRequiresDob: row?.match_requires_dob ?? true,
  };
}

export async function publishedNotice(trx, organizationId, language = 'en') {
  return trx('privacy_notice_versions')
    .where({ organization_id: organizationId, status: 'published', language })
    .first('id', 'version', 'title', 'content', 'published_at', 'language');
}

/** Finds or creates the contact for a phone number. `verified` stamps phone_verified_at. */
export async function upsertContact(trx, organizationId, phone, { verified = false } = {}) {
  await trx('contacts')
    .insert({ organization_id: organizationId, phone_e164: phone })
    .onConflict(['organization_id', 'phone_e164'])
    .ignore();
  const query = trx('contacts').where({ organization_id: organizationId, phone_e164: phone });
  if (verified) {
    await query.clone().whereNull('phone_verified_at').update({ phone_verified_at: trx.fn.now() });
  }
  return query.first();
}

async function nextPatientNumber(trx, organizationId) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const {
      rows: [{ seq }],
    } = await trx.raw(
      'UPDATE organizations SET next_patient_seq = next_patient_seq + 1 WHERE id = ? RETURNING next_patient_seq - 1 AS seq',
      [organizationId],
    );
    const candidate = `P-${String(seq).padStart(6, '0')}`;
    const taken = await trx('patients')
      .where({ organization_id: organizationId, patient_number: candidate })
      .first('id');
    if (!taken) return candidate;
  }
  throw new AppError(409, 'PATIENT_NUMBER_UNAVAILABLE', 'Could not generate a patient number');
}

/** Possible duplicates of a new registration among active patients in the organization. */
export async function possibleDuplicates(trx, organizationId, subject) {
  const settings = await loadPatientSettings(trx, organizationId);
  const rows = await trx('patients as p')
    .leftJoin('contact_patient_links as l', function joinLinks() {
      this.on('l.patient_id', 'p.id').andOnVal('l.authorization_status', '<>', 'revoked');
    })
    .where('p.organization_id', organizationId)
    .where('p.status', 'active')
    .where((w) => {
      if (subject.dateOfBirth) w.orWhere('p.date_of_birth', subject.dateOfBirth);
      if (subject.contactIds.length) w.orWhereIn('l.contact_id', subject.contactIds);
      if (!settings.matchRequiresDob) w.orWhereNull('p.date_of_birth');
      if (!subject.dateOfBirth && !subject.contactIds.length && settings.matchRequiresDob) {
        w.whereRaw('false');
      }
    })
    .groupBy('p.id')
    .limit(500)
    .select(
      'p.id',
      'p.full_name',
      'p.date_of_birth',
      trx.raw(
        'coalesce(array_agg(l.contact_id) FILTER (WHERE l.contact_id IS NOT NULL), ?) AS contact_ids',
        ['{}'],
      ),
    );
  const candidates = rows
    .filter((r) => r.id !== subject.excludeId)
    .map((r) => ({
      id: r.id,
      fullName: r.full_name,
      dateOfBirth: r.date_of_birth,
      contactIds: r.contact_ids,
    }));
  return findPossibleDuplicates(subject, candidates, settings);
}

export async function insertPatient(trx, organizationId, values) {
  const patientNumber = await nextPatientNumber(trx, organizationId);
  const [row] = await trx('patients')
    .insert({ ...values, organization_id: organizationId, patient_number: patientNumber })
    .returning('*');
  return row;
}

export async function linkContact(trx, organizationId, link) {
  try {
    const [row] = await trx('contact_patient_links')
      .insert({ ...link, organization_id: organizationId })
      .returning('*');
    return row;
  } catch (err) {
    if (err.code === '23505') {
      throw conflict('ALREADY_LINKED', 'This phone number is already linked to this patient');
    }
    throw err;
  }
}

export async function flagDuplicates(trx, organizationId, patientId, matches) {
  if (!matches.length) return;
  await trx('patient_duplicate_flags')
    .insert(
      matches.map((m) => ({
        organization_id: organizationId,
        patient_id: patientId,
        candidate_patient_id: m.patientId,
        score: m.score,
        reasons: JSON.stringify(m.reasons),
      })),
    )
    .onConflict(['patient_id', 'candidate_patient_id'])
    .ignore();
}

/**
 * Appends consent records (history is never overwritten; the newest record per purpose is the current
 * state). `choices` maps purposes to true (granted) or false (withdrawn / declined).
 * Recording "false" for a purpose that has never been granted writes nothing.
 */
export async function recordConsents(trx, organizationId, patientId, choices, ctx) {
  const current = (await currentConsents(trx, organizationId, [patientId]))[patientId] ?? {};
  // Every record points at the notice version that was in force when the choice was made.
  const notice = await publishedNotice(trx, organizationId);
  if (choices.privacy_notice === true && !notice) {
    throw new AppError(
      409,
      'NOTICE_NOT_PUBLISHED',
      'Publish a privacy notice (Settings → Privacy notices) before registering patients',
    );
  }
  const rows = [];
  for (const [purpose, granted] of Object.entries(choices)) {
    if (granted === undefined) continue;
    const now = current[purpose];
    if (granted && now?.status === 'granted' && purpose !== 'privacy_notice') continue;
    if (!granted && now?.status !== 'granted') continue;
    if (purpose === 'privacy_notice' && !granted) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'The privacy notice acknowledgement cannot be withdrawn here; raise a privacy request instead',
      );
    }
    rows.push({
      organization_id: organizationId,
      patient_id: patientId,
      acting_contact_id: ctx.actingContactId ?? null,
      acting_relationship: ctx.actingRelationship ?? null,
      purpose,
      channel: ctx.channel,
      notice_version_id: notice?.id ?? null,
      status: granted ? 'granted' : 'withdrawn',
      withdrawn_at: granted ? null : trx.fn.now(),
      capture_source: ctx.source,
      captured_by_user_id: ctx.actorUserId ?? null,
    });
  }
  if (rows.length) await trx('consents').insert(rows);
  return rows.length;
}

/** { patientId: { purpose: { status, capturedAt, channel, noticeVersion } } } — newest record wins. */
export async function currentConsents(trx, organizationId, patientIds) {
  if (!patientIds.length) return {};
  const rows = await trx('consents as c')
    .leftJoin('privacy_notice_versions as n', 'n.id', 'c.notice_version_id')
    .where('c.organization_id', organizationId)
    .whereIn('c.patient_id', patientIds)
    .distinctOn('c.patient_id', 'c.purpose')
    .orderBy([
      { column: 'c.patient_id' },
      { column: 'c.purpose' },
      { column: 'c.captured_at', order: 'desc' },
      { column: 'c.id', order: 'desc' },
    ])
    .select('c.patient_id', 'c.purpose', 'c.status', 'c.captured_at', 'c.channel', 'n.version');
  const out = {};
  for (const r of rows) {
    out[r.patient_id] ??= {};
    out[r.patient_id][r.purpose] = {
      status: r.status,
      capturedAt: r.captured_at,
      channel: r.channel,
      noticeVersion: r.version ?? null,
    };
  }
  return out;
}

/**
 * Whether a service message may be sent to a patient on a channel (spec: consent withdrawal updates
 * future communication eligibility). Marketing is never implied by service consent.
 */
export async function communicationAllowed(trx, organizationId, patientId, channel) {
  const purpose = { whatsapp: 'whatsapp_service', sms: 'sms_service', marketing: 'marketing' }[
    channel
  ];
  if (!purpose) return false;
  const c = (await currentConsents(trx, organizationId, [patientId]))[patientId] ?? {};
  return c[purpose]?.status === 'granted';
}

export const presentConsents = (map = {}) =>
  Object.fromEntries(
    CONSENT_PURPOSES.map((p) => [
      p,
      map[p]
        ? map[p]
        : { status: 'not_given', capturedAt: null, channel: null, noticeVersion: null },
    ]),
  );

/**
 * Registration by the person themselves (patient website or WhatsApp), on a phone number they control.
 *
 * - The same person already registered on this number (same name ignoring case, spacing,
 *   punctuation and titles, and the same date of birth) is not created again.
 * - The first "self" profile on the number is authorized; anyone else (family) waits for staff to
 *   confirm the relationship (phone possession is not proof of authority over another person).
 * - Possible duplicates elsewhere in the hospital are flagged for staff review, never merged.
 */
export async function selfRegister(trx, orgId, contact, body, ctx) {
  if (body.branchId) {
    const b = await trx('branches')
      .where({ organization_id: orgId, id: body.branchId, status: 'active' })
      .first('id');
    if (!b) throw new AppError(400, 'VALIDATION_ERROR', 'Unknown branch');
  }
  const matches = await possibleDuplicates(trx, orgId, {
    fullName: body.fullName,
    dateOfBirth: body.dateOfBirth,
    contactIds: [contact.id],
  });
  const ownLinks = await trx('contact_patient_links')
    .where({ organization_id: orgId, contact_id: contact.id })
    .whereNot('authorization_status', 'revoked')
    .pluck('patient_id');
  const already = matches.find(
    (m) =>
      ownLinks.includes(m.patientId) &&
      m.reasons.includes('same_name') &&
      m.reasons.includes('same_date_of_birth'),
  );
  if (already) {
    throw new AppError(
      409,
      'ALREADY_REGISTERED',
      'This person is already registered on this phone number.',
    );
  }
  const hasSelf = await trx('contact_patient_links')
    .where({
      organization_id: orgId,
      contact_id: contact.id,
      relationship: 'self',
      authorization_status: 'authorized',
    })
    .first('id');
  const authorized = body.relationship === 'self' && !hasSelf;

  const patient = await insertPatient(trx, orgId, {
    full_name: body.fullName,
    date_of_birth: body.dateOfBirth,
    gender: body.gender ?? null,
    email: body.email ?? null,
    registered_branch_id: body.branchId ?? null,
    registration_source: ctx.channel,
  });
  await linkContact(trx, orgId, {
    contact_id: contact.id,
    patient_id: patient.id,
    relationship: body.relationship,
    authorization_status: authorized ? 'authorized' : 'pending',
    authorized_at: authorized ? trx.fn.now() : null,
    created_via: ctx.channel,
  });
  await recordConsents(
    trx,
    orgId,
    patient.id,
    {
      privacy_notice: true,
      ...Object.fromEntries(
        Object.entries(body.consents ?? {}).map(([k, v]) => [CONSENT_KEYS[k], v]),
      ),
    },
    {
      channel: ctx.channel,
      source: ctx.source,
      actingContactId: contact.id,
      actingRelationship: body.relationship,
    },
  );
  await flagDuplicates(trx, orgId, patient.id, matches);
  await trx('audit_logs').insert({
    organization_id: orgId,
    action: 'patient.registered',
    entity_type: 'patient',
    entity_id: patient.id,
    ip: ctx.ip ?? null,
    request_id: ctx.requestId ?? null,
    metadata: { channel: ctx.channel, relationship: body.relationship, authorized },
  });
  return {
    id: patient.id,
    patientNumber: authorized ? patient.patient_number : null,
    fullName: patient.full_name,
    authorizationStatus: authorized ? 'authorized' : 'pending',
  };
}
