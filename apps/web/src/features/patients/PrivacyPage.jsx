import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import QRCode from 'qrcode';
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
import { RELATIONSHIP_LABEL, REQUEST_TYPE_LABEL, formatDate } from './format';

const TABS = [
  ['links', 'Family links to authorize'],
  ['duplicates', 'Duplicate review'],
  ['requests', 'Privacy requests'],
  ['notices', 'Privacy notices'],
  ['qr', 'Clinic QR page'],
  ['settings', 'Matching settings'],
];

export function PrivacyPage() {
  const auth = useAuth();
  const isAdmin = auth.can('privacy.manage');
  const tabs = TABS.filter(([k]) => isAdmin || k === 'links' || k === 'qr');
  const [tab, setTab] = useState(tabs[0][0]);
  return (
    <>
      <PageHeader
        title="Patient privacy"
        description="Privacy notices, family link authorization, duplicate review and data requests."
      />
      <div className="mb-4 flex flex-wrap gap-2" role="tablist">
        {tabs.map(([k, label]) => (
          <Button
            key={k}
            role="tab"
            aria-selected={tab === k}
            variant={tab === k ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setTab(k)}
          >
            {label}
          </Button>
        ))}
      </div>
      {tab === 'links' && <PendingLinks />}
      {tab === 'duplicates' && <Duplicates />}
      {tab === 'requests' && <Requests />}
      {tab === 'notices' && <Notices />}
      {tab === 'qr' && <ClinicQr />}
      {tab === 'settings' && <MatchingSettings />}
    </>
  );
}

function PendingLinks() {
  const qc = useQueryClient();
  const links = useQuery({
    queryKey: ['pending-links'],
    queryFn: () => apiFetch('/patients/links/pending'),
  });
  const authorize = useMutation({
    mutationFn: (l) =>
      apiFetch(`/patients/${l.patient.id}/contacts/${l.linkId}/authorize`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pending-links'] }),
  });
  return (
    <Card title="Family members registered on the QR page">
      <p className="mb-3 text-sm text-slate-600">
        A verified phone number does not prove someone may act for another person. Confirm the
        relationship (for example at the next visit) before authorizing. Pending patients cannot be
        booked through WhatsApp.
      </p>
      <ErrorMessage error={links.error || authorize.error} />
      {links.isPending && <Spinner />}
      {links.data?.data.length === 0 && <p className="text-sm text-slate-500">Nothing pending.</p>}
      <ul className="divide-y divide-slate-100">
        {links.data?.data.map((l) => (
          <li
            key={l.linkId}
            className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
          >
            <span>
              <Link to={`/patients/${l.patient.id}`} className="font-medium text-brand-700">
                {l.patient.fullName}
              </Link>{' '}
              ({l.patient.patientNumber}) · {RELATIONSHIP_LABEL[l.relationship]} of {l.phone}
              {l.phoneVerified && <Badge tone="green">OTP verified</Badge>}
            </span>
            <Button size="sm" onClick={() => authorize.mutate(l)} disabled={authorize.isPending}>
              Authorize
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Duplicates() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('open');
  const flags = useQuery({
    queryKey: ['duplicates', status],
    queryFn: () => apiFetch(`/privacy/duplicates?status=${status}`),
  });
  const decide = useMutation({
    mutationFn: ({ id, body }) =>
      apiFetch(`/privacy/duplicates/${id}/decide`, { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['duplicates'] }),
  });
  const ask = (f, decision, keepPatientId) => {
    const reason = window.prompt(
      decision === 'duplicate'
        ? 'Why are these the same person? (recorded in the audit log)'
        : 'Why are these different people?',
    );
    if (reason) decide.mutate({ id: f.id, body: { decision, keepPatientId, reason } });
  };
  const side = (p) => (
    <div>
      <Link to={`/patients/${p.id}`} className="font-medium text-brand-700">
        {p.fullName}
      </Link>
      <p className="text-xs text-slate-500">
        {p.patientNumber} · born {formatDate(p.dateOfBirth)} · {p.status}
      </p>
    </div>
  );
  return (
    <Card
      title="Possible duplicate records"
      actions={
        <Select
          aria-label="Status"
          className="w-40"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="open">Open</option>
          <option value="duplicate">Merged</option>
          <option value="not_duplicate">Not duplicates</option>
        </Select>
      }
    >
      <p className="mb-3 text-sm text-slate-600">
        Records are never merged automatically. Merging keeps one record and marks the other as
        merged (nothing is deleted).
      </p>
      <ErrorMessage error={flags.error || decide.error} />
      {flags.isPending && <Spinner />}
      {flags.data?.data.length === 0 && (
        <p className="text-sm text-slate-500">Nothing to review.</p>
      )}
      <ul className="divide-y divide-slate-100">
        {flags.data?.data.map((f) => (
          <li key={f.id} className="grid gap-3 py-3 text-sm md:grid-cols-[1fr_1fr_auto]">
            {side(f.patient)}
            {side(f.candidate)}
            <div className="flex flex-wrap items-start gap-2">
              <span className="text-xs text-slate-500">
                score {f.score} · {f.reasons.join(', ').replace(/_/g, ' ')}
              </span>
              {f.status === 'open' && (
                <>
                  <Button size="sm" variant="secondary" onClick={() => ask(f, 'not_duplicate')}>
                    Different people
                  </Button>
                  <Button size="sm" onClick={() => ask(f, 'duplicate', f.candidate.id)}>
                    Keep {f.candidate.patientNumber}
                  </Button>
                  <Button size="sm" onClick={() => ask(f, 'duplicate', f.patient.id)}>
                    Keep {f.patient.patientNumber}
                  </Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Requests() {
  const qc = useQueryClient();
  const requests = useQuery({
    queryKey: ['privacy-requests'],
    queryFn: () => apiFetch('/privacy/requests'),
  });
  const update = useMutation({
    mutationFn: ({ id, body }) => apiFetch(`/privacy/requests/${id}`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['privacy-requests'] }),
  });
  const close = (r, status) => {
    const resolution = window.prompt('Describe the outcome (shared with the patient on request)');
    if (resolution) update.mutate({ id: r.id, body: { status, resolution } });
  };
  return (
    <Card title="Data principal requests">
      <p className="mb-3 text-sm text-slate-600">
        Requests from patients about their data. Response timelines depend on the applicable law;
        follow your legal adviser&apos;s guidance.
      </p>
      <ErrorMessage error={requests.error || update.error} />
      {requests.isPending && <Spinner />}
      {requests.data?.data.length === 0 && <p className="text-sm text-slate-500">No requests.</p>}
      <ul className="divide-y divide-slate-100">
        {requests.data?.data.map((r) => (
          <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-3 text-sm">
            <div>
              <p>
                <span className="font-medium">{REQUEST_TYPE_LABEL[r.requestType]}</span> ·{' '}
                <Link to={`/patients/${r.patient.id}`} className="text-brand-700">
                  {r.patient.fullName}
                </Link>{' '}
                · {formatDate(r.createdAt)} via {r.channel}
              </p>
              <p className="text-slate-600">{r.details}</p>
              {r.resolution && <p className="text-xs text-slate-500">Outcome: {r.resolution}</p>}
            </div>
            <div className="flex items-center gap-2">
              <Badge
                tone={
                  { open: 'amber', in_progress: 'brand', completed: 'green', rejected: 'red' }[
                    r.status
                  ]
                }
              >
                {r.status.replace('_', ' ')}
              </Badge>
              {r.status === 'open' && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => update.mutate({ id: r.id, body: { status: 'in_progress' } })}
                >
                  Start
                </Button>
              )}
              {['open', 'in_progress'].includes(r.status) && (
                <>
                  <Button size="sm" onClick={() => close(r, 'completed')}>
                    Complete
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => close(r, 'rejected')}>
                    Reject
                  </Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Notices() {
  const qc = useQueryClient();
  const notices = useQuery({
    queryKey: ['privacy-notices'],
    queryFn: () => apiFetch('/privacy/notices'),
  });
  const [form, setForm] = useState({ version: '', title: '', content: '' });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['privacy-notices'] });
  const create = useMutation({
    mutationFn: () => apiFetch('/privacy/notices', { method: 'POST', body: form }),
    onSuccess: () => (invalidate(), setForm({ version: '', title: '', content: '' })),
  });
  const act = useMutation({
    mutationFn: ({ id, method, path = '' }) =>
      apiFetch(`/privacy/notices/${id}${path}`, { method }),
    onSuccess: invalidate,
  });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Versions">
        <ErrorMessage error={notices.error || act.error} />
        {notices.isPending && <Spinner />}
        {notices.data?.data.length === 0 && (
          <p className="text-sm text-slate-500">
            No notices yet. Patients can&apos;t be registered until one is published.
          </p>
        )}
        <ul className="divide-y divide-slate-100">
          {notices.data?.data.map((n) => (
            <li key={n.id} className="py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  {n.version} · {n.title}
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={{ published: 'green', draft: 'amber', retired: 'slate' }[n.status]}>
                    {n.status}
                  </Badge>
                  {n.status === 'draft' && (
                    <>
                      <Button
                        size="sm"
                        onClick={() => act.mutate({ id: n.id, method: 'POST', path: '/publish' })}
                      >
                        Publish
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => act.mutate({ id: n.id, method: 'DELETE' })}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </span>
              </div>
              <details className="mt-1 text-slate-600">
                <summary className="cursor-pointer text-xs">Show text</summary>
                <p className="mt-1 whitespace-pre-wrap">{n.content}</p>
              </details>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="New version (draft)">
        <Alert tone="amber">
          Write the notice with your legal adviser. Published versions can&apos;t be edited, because
          consents refer to the exact wording shown.
        </Alert>
        <ErrorMessage error={create.error} />
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Version" htmlFor="nv">
            <Input
              id="nv"
              required
              placeholder="e.g. 2026.1"
              value={form.version}
              onChange={(e) => setForm({ ...form, version: e.target.value })}
            />
          </Field>
          <Field label="Title" htmlFor="nt">
            <Input
              id="nt"
              required
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </Field>
          <Field label="Notice text" htmlFor="nc">
            <textarea
              id="nc"
              required
              minLength={20}
              rows={8}
              className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
            />
          </Field>
          <Button type="submit" disabled={create.isPending}>
            Save draft
          </Button>
        </form>
      </Card>
    </div>
  );
}

function ClinicQr() {
  const { me } = useAuth();
  const site = (import.meta.env.VITE_PATIENT_SITE_URL || 'http://localhost:5174').replace(
    /\/$/,
    '',
  );
  const url = `${site}/clinic/${me.organization.slug}`;
  const [img, setImg] = useState(null);
  useEffect(() => {
    QRCode.toDataURL(url, { width: 320, margin: 2 }).then(setImg, () => setImg(null));
  }, [url]);
  return (
    <Card title="Clinic QR page">
      <div className="flex flex-wrap items-center gap-6">
        {img && (
          <img
            src={img}
            alt={`QR code for ${url}`}
            className="h-56 w-56 rounded border border-slate-200"
          />
        )}
        <div className="space-y-2 text-sm">
          <p>
            Print this QR code at the reception. Patients scan it, sign in to the patient website
            with their phone number, and register themselves or family members and book
            appointments. Patients who type the hospital code instead use:{' '}
            <strong>{me.organization.slug}</strong>
          </p>
          <p className="font-mono text-xs break-all text-slate-600">{url}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => navigator.clipboard?.writeText(url)}
            >
              Copy link
            </Button>
            {img && (
              <a
                href={img}
                download="clinic-qr.png"
                className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700"
              >
                Download QR image
              </a>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

function MatchingSettings() {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ['patient-settings'],
    queryFn: () => apiFetch('/privacy/settings'),
  });
  const [form, setForm] = useState(null);
  const value = form ?? settings.data;
  const save = useMutation({
    mutationFn: () =>
      apiFetch('/privacy/settings', {
        method: 'PUT',
        body: {
          nameSimilarityThreshold: Number(value.nameSimilarityThreshold),
          matchRequiresDob: value.matchRequiresDob,
        },
      }),
    onSuccess: (d) => (qc.setQueryData(['patient-settings'], d), setForm(null)),
  });
  if (!value) return <Spinner />;
  return (
    <Card title="Duplicate matching">
      <ErrorMessage error={save.error} />
      {save.isSuccess && <Alert tone="green">Saved.</Alert>}
      <form
        className="mt-3 max-w-md space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field
          label="Name similarity threshold"
          htmlFor="thr"
          hint="0.5–1. Higher means only very similar names are flagged."
        >
          <Input
            id="thr"
            type="number"
            min="0.5"
            max="1"
            step="0.01"
            value={value.nameSimilarityThreshold}
            onChange={(e) => setForm({ ...value, nameSimilarityThreshold: e.target.value })}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.matchRequiresDob}
            onChange={(e) => setForm({ ...value, matchRequiresDob: e.target.checked })}
          />
          Only flag when the date of birth also matches (or a phone is shared)
        </label>
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
      </form>
    </Card>
  );
}
