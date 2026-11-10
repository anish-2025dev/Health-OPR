import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/features/auth/auth-context';
import {
  Alert,
  Badge,
  Button,
  Card,
  ErrorMessage,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui';
import {
  CONSENT_LABEL,
  CONSENT_STATUS,
  CONSENT_TONE,
  GENDER_LABEL,
  RELATIONSHIPS,
  RELATIONSHIP_LABEL,
  REQUEST_TYPE_LABEL,
  age,
  formatDate,
} from './format';

const STATUS_TONE = { active: 'green', inactive: 'slate', merged: 'amber' };
const LINK_TONE = { authorized: 'green', pending: 'amber', revoked: 'red' };

// ------------------------------------------------------------------ search
export function PatientsPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [phone, setPhone] = useState('');
  const [status, setStatus] = useState('active');
  const params = new URLSearchParams({ status, limit: '50' });
  if (q.trim()) params.set('q', q.trim());
  if (phone.replace(/\D/g, '').length >= 4) params.set('phone', phone.trim());

  const patients = useQuery({
    queryKey: ['patients', params.toString()],
    queryFn: () => apiFetch(`/patients?${params}`),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Patients"
        description="Find a patient by name, patient number or phone. A phone number can belong to several family members."
        actions={
          auth.can('patients.manage') && (
            <Button onClick={() => navigate('/patients/new')}>Register patient</Button>
          )
        }
      />
      <Card>
        <div className="mb-4 grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
          <Input
            aria-label="Search by name or number"
            placeholder="Name or patient number"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Input
            aria-label="Search by phone"
            placeholder="Phone (last 4+ digits)"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="merged">Merged</option>
            <option value="all">All</option>
          </Select>
        </div>
        {patients.isPending && <Spinner />}
        <ErrorMessage error={patients.error} />
        {patients.data && patients.data.data.length === 0 && (
          <p className="text-sm text-slate-500">
            No patients found. Unregistered people can register at the reception or through the
            clinic QR page.
          </p>
        )}
        {patients.data && patients.data.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500 uppercase">
                <tr>
                  <th className="py-2 pr-4">Patient</th>
                  <th className="py-2 pr-4">Age / gender</th>
                  <th className="py-2 pr-4">Phone</th>
                  <th className="py-2 pr-4">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {patients.data.data.map((p) => (
                  <tr key={p.id}>
                    <td className="py-2 pr-4">
                      <Link to={`/patients/${p.id}`} className="font-medium text-brand-700">
                        {p.fullName}
                      </Link>
                      <p className="text-xs text-slate-500">{p.patientNumber}</p>
                    </td>
                    <td className="py-2 pr-4 text-slate-600">
                      {age(p.dateOfBirth) ?? '—'} {p.gender ? `· ${GENDER_LABEL[p.gender]}` : ''}
                    </td>
                    <td className="py-2 pr-4 text-slate-600">
                      {p.contacts
                        .filter((c) => c.authorizationStatus !== 'revoked')
                        .map((c) => (
                          <span key={c.linkId} className="block">
                            {c.phone}{' '}
                            <span className="text-xs text-slate-400">
                              ({RELATIONSHIP_LABEL[c.relationship]})
                            </span>
                          </span>
                        ))}
                    </td>
                    <td className="py-2 pr-4">
                      <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ registration
const EMPTY = {
  fullName: '',
  dateOfBirth: '',
  gender: '',
  phone: '',
  relationship: 'self',
  email: '',
  address: '',
  branchId: '',
  whatsappService: false,
  smsService: false,
  marketing: false,
  privacyNoticeAcknowledged: false,
};

export function RegisterPatientPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState(EMPTY);
  const [matches, setMatches] = useState(null);
  const set = (k) => (e) =>
    setForm((f) => ({
      ...f,
      [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
    }));

  const branches = useQuery({ queryKey: ['branches'], queryFn: () => apiFetch('/branches') });
  const notices = useQuery({
    queryKey: ['privacy-notices'],
    queryFn: () => apiFetch('/privacy/notices'),
  });
  const notice = notices.data?.data.find((n) => n.status === 'published' && n.language === 'en');
  const branchId = form.branchId || branches.data?.data?.[0]?.id || '';

  const save = useMutation({
    mutationFn: (confirmNotDuplicate) =>
      apiFetch('/patients', {
        method: 'POST',
        body: {
          fullName: form.fullName,
          dateOfBirth: form.dateOfBirth || null,
          gender: form.gender || null,
          email: form.email || null,
          address: form.address || null,
          phone: form.phone,
          relationship: form.relationship,
          branchId,
          privacyNoticeAcknowledged: form.privacyNoticeAcknowledged,
          consents: {
            whatsappService: form.whatsappService,
            smsService: form.smsService,
            marketing: form.marketing,
          },
          confirmNotDuplicate,
        },
      }),
    onSuccess: (p) => navigate(`/patients/${p.id}`),
    onError: (err) => {
      if (err.code === 'POSSIBLE_DUPLICATE') setMatches(err.details.matches);
    },
  });

  return (
    <>
      <PageHeader
        title="Register patient"
        description="Reception-assisted registration. Check the person's details in person."
      />
      {notices.data && !notice && (
        <div className="mb-4">
          <Alert tone="amber">
            No privacy notice is published yet. An admin must publish one under{' '}
            <Link to="/privacy" className="underline">
              Privacy
            </Link>{' '}
            before patients can be registered.
          </Alert>
        </div>
      )}
      <form
        className="grid gap-6 lg:grid-cols-[2fr_1fr]"
        onSubmit={(e) => {
          e.preventDefault();
          setMatches(null);
          save.mutate(false);
        }}
      >
        <Card title="Patient details">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" htmlFor="fullName">
              <Input id="fullName" required value={form.fullName} onChange={set('fullName')} />
            </Field>
            <Field label="Date of birth" htmlFor="dob" hint="Helps tell family members apart">
              <Input id="dob" type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} />
            </Field>
            <Field label="Gender" htmlFor="gender">
              <Select id="gender" value={form.gender} onChange={set('gender')}>
                <option value="">—</option>
                {Object.entries(GENDER_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Branch" htmlFor="branch">
              <Select id="branch" value={branchId} onChange={set('branchId')}>
                {branches.data?.data.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Phone number" htmlFor="phone" hint="May be shared with family members">
              <Input
                id="phone"
                required
                inputMode="tel"
                value={form.phone}
                onChange={set('phone')}
              />
            </Field>
            <Field label="Relationship to the phone owner" htmlFor="relationship">
              <Select id="relationship" value={form.relationship} onChange={set('relationship')}>
                {RELATIONSHIPS.map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Email (optional)" htmlFor="email">
              <Input id="email" type="email" value={form.email} onChange={set('email')} />
            </Field>
            <Field label="Address (optional)" htmlFor="address">
              <Input id="address" value={form.address} onChange={set('address')} />
            </Field>
          </div>
        </Card>
        <Card title="Privacy and communication">
          {notice && (
            <details className="mb-3 text-sm">
              <summary className="cursor-pointer text-brand-700">
                Privacy notice {notice.version} — read with the patient
              </summary>
              <p className="mt-2 whitespace-pre-wrap text-slate-600">{notice.content}</p>
            </details>
          )}
          <div className="space-y-3 text-sm">
            <Check
              label="Patient has read and acknowledged the privacy notice (required)"
              checked={form.privacyNoticeAcknowledged}
              onChange={set('privacyNoticeAcknowledged')}
            />
            <p className="pt-2 text-xs font-medium text-slate-500 uppercase">
              Patient agrees to receive (each optional)
            </p>
            <Check
              label="Appointment updates on WhatsApp"
              checked={form.whatsappService}
              onChange={set('whatsappService')}
            />
            <Check
              label="Appointment updates by SMS"
              checked={form.smsService}
              onChange={set('smsService')}
            />
            <Check
              label="Health camps and offers (marketing)"
              checked={form.marketing}
              onChange={set('marketing')}
            />
          </div>
        </Card>
        <div className="space-y-3 lg:col-span-2">
          {save.error && save.error.code !== 'POSSIBLE_DUPLICATE' && (
            <ErrorMessage error={save.error} />
          )}
          {matches && (
            <Alert tone="amber">
              <p className="font-medium">This person may already be registered:</p>
              <ul className="mt-2 space-y-1">
                {matches.map((m) => (
                  <li key={m.patientId}>
                    <Link to={`/patients/${m.patientId}`} className="underline">
                      {m.fullName} ({m.patientNumber})
                    </Link>{' '}
                    · born {formatDate(m.dateOfBirth)} · {m.reasons.join(', ').replace(/_/g, ' ')}
                  </li>
                ))}
              </ul>
              <p className="mt-2">
                Open the existing record if it is the same person. If not, register anyway; the
                records will be listed for review and are never merged automatically.
              </p>
              <Button
                className="mt-3"
                variant="secondary"
                disabled={save.isPending}
                onClick={() => save.mutate(true)}
              >
                Not the same person — register anyway
              </Button>
            </Alert>
          )}
          <Button type="submit" disabled={save.isPending || !notice}>
            {save.isPending ? 'Saving…' : 'Register patient'}
          </Button>
        </div>
      </form>
    </>
  );
}

function Check({ label, checked, onChange }) {
  return (
    <label className="flex items-start gap-2">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

// ------------------------------------------------------------------ profile
export function PatientDetailPage() {
  const { id } = useParams();
  const auth = useAuth();
  const canManage = auth.can('patients.manage');
  const qc = useQueryClient();
  const patient = useQuery({
    queryKey: ['patient', id],
    queryFn: () => apiFetch(`/patients/${id}`),
  });
  const history = useQuery({
    queryKey: ['patient', id, 'consents'],
    queryFn: () => apiFetch(`/patients/${id}/consents`),
  });
  const refresh = (data) => {
    qc.setQueryData(['patient', id], data);
    qc.invalidateQueries({ queryKey: ['patient', id, 'consents'] });
    qc.invalidateQueries({ queryKey: ['patients'] });
  };
  const call = useMutation({
    mutationFn: ({ path, body }) => apiFetch(`/patients/${id}${path}`, { method: 'POST', body }),
    onSuccess: refresh,
  });
  const [link, setLink] = useState({ phone: '', relationship: 'parent' });
  const [request, setRequest] = useState({ requestType: 'access', details: '' });
  const raise = useMutation({
    mutationFn: () =>
      apiFetch('/privacy/requests', { method: 'POST', body: { patientId: id, ...request } }),
    onSuccess: () => setRequest({ requestType: 'access', details: '' }),
  });

  if (patient.isPending) return <Spinner />;
  if (patient.error) return <ErrorMessage error={patient.error} />;
  const p = patient.data;

  return (
    <>
      <PageHeader
        title={p.fullName}
        description={`${p.patientNumber} · ${age(p.dateOfBirth) ?? '—'} years · ${
          p.gender ? GENDER_LABEL[p.gender] : 'gender not recorded'
        }`}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
            {p.status === 'active' && auth.can('appointments.manage') && (
              <Link
                to={`/reception?patientId=${p.id}`}
                className="rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white"
              >
                Book / walk-in
              </Link>
            )}
          </div>
        }
      />
      {p.status === 'merged' && (
        <div className="mb-4">
          <Alert tone="amber">
            This record was merged.{' '}
            <Link className="underline" to={`/patients/${p.mergedIntoPatientId}`}>
              Open the kept record
            </Link>
          </Alert>
        </div>
      )}
      <ErrorMessage error={call.error} />
      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        <Card title="Details">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-slate-500">Date of birth</dt>
            <dd>{formatDate(p.dateOfBirth)}</dd>
            {p.email !== undefined && (
              <>
                <dt className="text-slate-500">Email</dt>
                <dd>{p.email ?? '—'}</dd>
                <dt className="text-slate-500">Address</dt>
                <dd>{p.address ?? '—'}</dd>
              </>
            )}
            <dt className="text-slate-500">Registered</dt>
            <dd>
              {formatDate(p.createdAt)} via {p.registrationSource}
              {p.registeredBranch ? ` · ${p.registeredBranch.name}` : ''}
            </dd>
          </dl>
        </Card>

        <Card title="Phone numbers and family links">
          <ul className="space-y-3 text-sm">
            {p.contacts.map((c) => (
              <li key={c.linkId} className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{c.phone}</p>
                  <p className="text-xs text-slate-500">
                    {RELATIONSHIP_LABEL[c.relationship]} · added via {c.createdVia}
                    {c.phoneVerified ? ' · phone verified by OTP' : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={LINK_TONE[c.authorizationStatus]}>{c.authorizationStatus}</Badge>
                  {canManage && c.authorizationStatus === 'pending' && (
                    <Button
                      size="sm"
                      onClick={() =>
                        call.mutate({ path: `/contacts/${c.linkId}/authorize`, body: {} })
                      }
                    >
                      Authorize
                    </Button>
                  )}
                  {canManage && c.authorizationStatus !== 'revoked' && (
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        const reason = window.prompt('Why is this link being removed?');
                        if (reason)
                          call.mutate({ path: `/contacts/${c.linkId}/revoke`, body: { reason } });
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {canManage && p.status === 'active' && (
            <form
              className="mt-4 grid gap-2 border-t border-slate-100 pt-4 sm:grid-cols-[1fr_1fr_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                call.mutate(
                  { path: '/contacts', body: link },
                  {
                    onSuccess: (d) => (refresh(d), setLink({ phone: '', relationship: 'parent' })),
                  },
                );
              }}
            >
              <Input
                aria-label="Phone to link"
                placeholder="Another phone number"
                inputMode="tel"
                required
                value={link.phone}
                onChange={(e) => setLink({ ...link, phone: e.target.value })}
              />
              <Select
                aria-label="Relationship"
                value={link.relationship}
                onChange={(e) => setLink({ ...link, relationship: e.target.value })}
              >
                {RELATIONSHIPS.map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
              <Button type="submit" variant="secondary">
                Link phone
              </Button>
            </form>
          )}
        </Card>

        <Card title="Consent">
          <ul className="space-y-2 text-sm">
            {Object.entries(p.consents).map(([purpose, c]) => (
              <li key={purpose} className="flex items-center justify-between gap-2">
                <span>
                  {CONSENT_LABEL[purpose]}
                  {c.capturedAt && (
                    <span className="block text-xs text-slate-500">
                      {formatDate(c.capturedAt)} via {c.channel}
                      {c.noticeVersion ? ` · notice ${c.noticeVersion}` : ''}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={CONSENT_TONE[c.status]}>{CONSENT_STATUS[c.status]}</Badge>
                  {canManage && purpose !== 'privacy_notice' && p.status !== 'merged' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        call.mutate({
                          path: '/consents',
                          body: {
                            [{
                              whatsapp_service: 'whatsappService',
                              sms_service: 'smsService',
                              marketing: 'marketing',
                            }[purpose]]: c.status !== 'granted',
                          },
                        })
                      }
                    >
                      {c.status === 'granted' ? 'Withdraw' : 'Record yes'}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {history.data && history.data.data.length > 0 && (
            <details className="mt-4 text-xs text-slate-600">
              <summary className="cursor-pointer">
                Consent history ({history.data.data.length})
              </summary>
              <ul className="mt-2 space-y-1">
                {history.data.data.map((h) => (
                  <li key={h.id}>
                    {new Date(h.capturedAt).toLocaleString('en-IN')} — {CONSENT_LABEL[h.purpose]}:{' '}
                    {h.status} via {h.channel}
                    {h.capturedBy ? ` by ${h.capturedBy}` : ''}
                    {h.actingRelationship
                      ? ` (acting: ${RELATIONSHIP_LABEL[h.actingRelationship]})`
                      : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Card>

        {auth.can('appointments.read') && <Visits patientId={p.id} />}
        {canManage && (
          <Card title="Privacy request">
            <p className="mb-3 text-sm text-slate-600">
              Record a request from the patient (access, correction, erasure, grievance or
              nomination). An admin handles it under Privacy.
            </p>
            {raise.isSuccess && (
              <div className="mb-3">
                <Alert tone="green">Request recorded.</Alert>
              </div>
            )}
            <ErrorMessage error={raise.error} />
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                raise.mutate();
              }}
            >
              <Select
                aria-label="Request type"
                value={request.requestType}
                onChange={(e) => setRequest({ ...request, requestType: e.target.value })}
              >
                {Object.entries(REQUEST_TYPE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
              <Input
                aria-label="Request details"
                placeholder="What the patient asked for"
                required
                minLength={3}
                value={request.details}
                onChange={(e) => setRequest({ ...request, details: e.target.value })}
              />
              <Button type="submit" variant="secondary" disabled={raise.isPending}>
                Record request
              </Button>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}

const VISIT_TONE = { completed: 'green', no_show: 'red', cancelled: 'red', booked: 'slate' };

function Visits({ patientId }) {
  const visits = useQuery({
    queryKey: ['visits', patientId],
    queryFn: () => apiFetch(`/queue/visits?patientId=${patientId}`),
  });
  return (
    <Card title="Visits">
      <ErrorMessage error={visits.error} />
      {visits.isPending && <Spinner />}
      {visits.data?.data.length === 0 && <p className="text-sm text-slate-500">No visits yet.</p>}
      <ul className="divide-y divide-slate-100 text-sm">
        {visits.data?.data.map((v) => (
          <li key={v.id} className="flex items-center justify-between gap-2 py-2">
            <span>
              {formatDate(v.date)} · {v.doctorName}
              <span className="block text-xs text-slate-500">
                Token {v.token} · {v.kind === 'walk_in' ? 'walk-in' : 'appointment'} ·{' '}
                {v.branchName}
              </span>
            </span>
            <Badge tone={VISIT_TONE[v.status] ?? 'amber'}>{v.status.replace('_', ' ')}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}
