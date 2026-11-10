import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { apiFetch } from '@/lib/api-client';
import {
  Alert,
  Badge,
  Button,
  Card,
  ErrorMessage,
  Field,
  Input,
  Select,
  Spinner,
} from '@/components/ui';
import {
  CONSENT_LABEL,
  GENDER_LABEL,
  RELATIONSHIPS,
  RELATIONSHIP_LABEL,
} from '@/features/patients/format';

/**
 * Public page behind the clinic's QR code. The person verifies their phone number by OTP, then
 * registers themselves or family members. The portal token is kept in memory only (closing the tab
 * signs out) and works only for this clinic's portal endpoints.
 */
export function ClinicPortalPage() {
  const { slug } = useParams();
  const base = `/public/clinics/${encodeURIComponent(slug)}`;
  const clinic = useQuery({
    queryKey: ['portal', slug],
    queryFn: () => apiFetch(base, { auth: false }),
    retry: false,
  });
  const [token, setToken] = useState(null);
  const call = (path, options = {}) =>
    apiFetch(`${base}${path}`, {
      ...options,
      auth: false,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto max-w-xl space-y-4">
        {clinic.isPending && <Spinner />}
        {clinic.error && <ErrorMessage error={clinic.error} />}
        {clinic.data && (
          <>
            <header className="text-center">
              <img src="/favicon.svg" alt="" className="mx-auto h-10 w-10" />
              <h1 className="mt-2 text-xl font-bold text-slate-900">
                {clinic.data.organization.name}
              </h1>
              <p className="text-sm text-slate-600">Patient registration</p>
            </header>
            {!clinic.data.privacyNotice && (
              <Alert tone="amber">
                Online registration is not open yet. Please ask at the reception.
              </Alert>
            )}
            {clinic.data.privacyNotice && !token && (
              <VerifyPhone call={call} onVerified={setToken} />
            )}
            {clinic.data.privacyNotice && token && (
              <Profiles clinic={clinic.data} call={call} onExpired={() => setToken(null)} />
            )}
            <p className="text-center text-xs text-slate-500">
              We send appointment messages without medical details. You can change your choices any
              time.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function VerifyPhone({ call, onVerified }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Verify your phone number">
      <ErrorMessage error={error} />
      <form
        className="mt-2 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            if (!sent) {
              await call('/otp/request', { method: 'POST', body: { phone } });
              setSent(true);
            } else {
              const r = await call('/otp/verify', {
                method: 'POST',
                body: { phone, code: code.trim() },
              });
              onVerified(r.portalToken);
            }
          });
        }}
      >
        <Field label="Mobile number" htmlFor="pphone">
          <Input
            id="pphone"
            inputMode="tel"
            autoComplete="tel"
            required
            disabled={sent}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </Field>
        {sent && (
          <Field label="6-digit code sent by SMS" htmlFor="pcode">
            <Input
              id="pcode"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              pattern="\d{6}"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {sent ? 'Verify' : 'Send code'}
          </Button>
          {sent && (
            <Button variant="ghost" onClick={() => (setSent(false), setCode(''))}>
              Change number
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}

const NEW = {
  fullName: '',
  dateOfBirth: '',
  gender: '',
  relationship: 'self',
  branchId: '',
  privacyNoticeAcknowledged: false,
  whatsappService: false,
  smsService: false,
  marketing: false,
};

function Profiles({ clinic, call, onExpired }) {
  const me = useQuery({
    queryKey: ['portal-me', clinic.organization.slug],
    queryFn: () => call('/me'),
  });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(NEW);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) =>
    setForm((f) => ({
      ...f,
      [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
    }));

  const expired = me.error?.status === 401;
  useEffect(() => {
    if (expired) onExpired();
  }, [expired, onExpired]);
  if (expired) return null;
  if (me.isPending) return <Spinner />;
  const patients = me.data?.patients ?? [];
  const showForm = adding || patients.length === 0;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await call('/patients', {
        method: 'POST',
        body: {
          fullName: form.fullName,
          dateOfBirth: form.dateOfBirth,
          gender: form.gender || null,
          relationship: form.relationship,
          branchId: form.branchId || null,
          privacyNoticeAcknowledged: form.privacyNoticeAcknowledged,
          consents: {
            whatsappService: form.whatsappService,
            smsService: form.smsService,
            marketing: form.marketing,
          },
        },
      });
      setNotice(
        r.authorizationStatus === 'authorized'
          ? `Registered. Patient number ${r.patientNumber}.`
          : `${r.fullName} is registered. The clinic will confirm your relationship at your next visit before you can book for them.`,
      );
      setForm(NEW);
      setAdding(false);
      await me.refetch();
    } catch (err) {
      if (err.status === 401) return onExpired();
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (p, key, value) => {
    try {
      await call(`/patients/${p.id}/consents`, { method: 'POST', body: { [key]: value } });
      await me.refetch();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      {notice && <Alert tone="green">{notice}</Alert>}
      <ErrorMessage error={error} />
      {patients.length > 0 && (
        <Card title={`Profiles on ${me.data.phone}`}>
          <ul className="divide-y divide-slate-100">
            {patients.map((p) => (
              <li key={p.id} className="py-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    <span className="font-medium">{p.fullName}</span>{' '}
                    <span className="text-slate-500">
                      ({p.relationship === 'self' ? 'Myself' : RELATIONSHIP_LABEL[p.relationship]})
                    </span>
                    {p.patientNumber && (
                      <span className="block text-xs text-slate-500">{p.patientNumber}</span>
                    )}
                  </span>
                  <Badge tone={p.authorizationStatus === 'authorized' ? 'green' : 'amber'}>
                    {p.authorizationStatus === 'authorized' ? 'Active' : 'Awaiting clinic check'}
                  </Badge>
                </div>
                {p.consents && (
                  <div className="mt-2 space-y-1">
                    {[
                      ['whatsappService', 'whatsapp_service'],
                      ['smsService', 'sms_service'],
                      ['marketing', 'marketing'],
                    ].map(([key, purpose]) => (
                      <label key={key} className="flex items-center gap-2 text-xs text-slate-600">
                        <input
                          type="checkbox"
                          checked={p.consents[purpose].status === 'granted'}
                          onChange={(e) => toggle(p, key, e.target.checked)}
                        />
                        {CONSENT_LABEL[purpose]}
                      </label>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {!adding && (
            <Button className="mt-3" variant="secondary" onClick={() => setAdding(true)}>
              Register a family member
            </Button>
          )}
        </Card>
      )}
      {showForm && (
        <Card title={patients.length ? 'Register a family member' : 'Register'}>
          <form className="space-y-3" onSubmit={submit}>
            <Field label="Full name" htmlFor="fn">
              <Input id="fn" required value={form.fullName} onChange={set('fullName')} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Date of birth" htmlFor="fd">
                <Input
                  id="fd"
                  type="date"
                  required
                  value={form.dateOfBirth}
                  onChange={set('dateOfBirth')}
                />
              </Field>
              <Field label="Gender" htmlFor="fg">
                <Select id="fg" value={form.gender} onChange={set('gender')}>
                  <option value="">—</option>
                  {Object.entries(GENDER_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="This person is my…" htmlFor="fr">
                <Select id="fr" value={form.relationship} onChange={set('relationship')}>
                  {RELATIONSHIPS.map(([k, v]) => (
                    <option key={k} value={k}>
                      {k === 'self' ? 'Myself' : v}
                    </option>
                  ))}
                </Select>
              </Field>
              {clinic.branches.length > 1 && (
                <Field label="Preferred branch" htmlFor="fb">
                  <Select id="fb" value={form.branchId} onChange={set('branchId')}>
                    <option value="">No preference</option>
                    {clinic.branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            <details className="rounded-lg border border-slate-200 p-3 text-sm">
              <summary className="cursor-pointer font-medium">
                {clinic.privacyNotice.title} (version {clinic.privacyNotice.version})
              </summary>
              <p className="mt-2 whitespace-pre-wrap text-slate-600">
                {clinic.privacyNotice.content}
              </p>
            </details>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.privacyNoticeAcknowledged}
                onChange={set('privacyNoticeAcknowledged')}
              />
              I have read the privacy notice (required)
            </label>
            <p className="text-xs font-medium text-slate-500 uppercase">Optional</p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.whatsappService}
                onChange={set('whatsappService')}
              />
              Send appointment updates on WhatsApp
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.smsService} onChange={set('smsService')} />
              Send appointment updates by SMS
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.marketing} onChange={set('marketing')} />
              Tell me about health camps and offers
            </label>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !form.privacyNoticeAcknowledged}>
                {busy ? 'Saving…' : 'Register'}
              </Button>
              {adding && (
                <Button variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </form>
        </Card>
      )}
    </>
  );
}
