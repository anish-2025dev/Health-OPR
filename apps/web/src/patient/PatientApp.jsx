import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router';
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
  REQUEST_TYPE_LABEL,
} from '@/features/patients/format';
import { QUEUE_STATUS, timeOf, todayIst } from '@/features/clinic/format';
import { TrackPage } from '@/features/clinic/QueuePages';
import {
  patientFetch,
  refreshPatientSession,
  setPatientAuthLost,
  setPatientToken,
} from './patient-api';

// ------------------------------------------------------------------ session
const PatientAuth = createContext(null);
const usePatientAuth = () => useContext(PatientAuth);

function PatientAuthProvider({ children }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState('loading');
  const lost = useCallback(() => {
    setPatientToken(null);
    qc.clear();
    setStatus('anonymous');
  }, [qc]);
  useEffect(() => {
    setPatientAuthLost(lost);
    refreshPatientSession().then((ok) => setStatus(ok ? 'authenticated' : 'anonymous'));
  }, [lost]);
  const value = useMemo(
    () => ({
      status,
      async signIn(phone, code) {
        const r = await patientFetch('/patient-auth/otp/verify', {
          method: 'POST',
          body: { phone, code },
          auth: false,
        });
        setPatientToken(r.accessToken);
        setStatus('authenticated');
      },
      async signOut() {
        await patientFetch('/patient-auth/logout', { method: 'POST', auth: false }).catch(() => {});
        lost();
      },
    }),
    [status, lost],
  );
  return <PatientAuth.Provider value={value}>{children}</PatientAuth.Provider>;
}

function Shell({ children }) {
  const auth = usePatientAuth();
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3">
          <Link to="/" className="flex items-center gap-2">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            <span className="text-sm font-semibold text-brand-900">HealthOS · Patients</span>
          </Link>
          {auth.status === 'authenticated' && (
            <Button size="sm" variant="ghost" onClick={() => auth.signOut()}>
              Sign out
            </Button>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-2xl space-y-4 px-4 py-6">{children}</main>
      <footer className="mx-auto max-w-2xl px-4 pb-8 text-center text-xs text-slate-500">
        Messages from hospitals never include medical details. Waiting times are estimates.
      </footer>
    </div>
  );
}

function SignIn({ title = 'Sign in with your phone number' }) {
  const auth = usePatientAuth();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!sent) {
        await patientFetch('/patient-auth/otp/request', {
          method: 'POST',
          body: { phone },
          auth: false,
        });
        setSent(true);
      } else {
        await auth.signIn(phone, code.trim());
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={title}>
      <p className="mb-3 text-sm text-slate-600">
        We&apos;ll send a 6-digit code by SMS. You stay signed in on this device afterwards.
      </p>
      <ErrorMessage error={error} />
      <form className="mt-2 space-y-3" onSubmit={submit}>
        <Field label="Mobile number" htmlFor="sphone">
          <Input
            id="sphone"
            inputMode="tel"
            autoComplete="tel"
            required
            disabled={sent}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </Field>
        {sent && (
          <Field label="6-digit code" htmlFor="scode">
            <Input
              id="scode"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {sent ? 'Verify and sign in' : 'Send code'}
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

// ------------------------------------------------------------------ home: my hospitals
function HomePage() {
  const auth = usePatientAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const me = useQuery({
    queryKey: ['patient-me'],
    queryFn: () => patientFetch('/patient/me'),
    enabled: auth.status === 'authenticated',
  });
  const join = useMutation({
    mutationFn: () => patientFetch('/patient/clinics', { method: 'POST', body: { code } }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['patient-me'] });
      navigate(`/clinic/${c.code}`);
    },
  });
  if (auth.status === 'loading') return <Spinner />;
  if (auth.status === 'anonymous') return <SignIn />;
  return (
    <>
      <Card title="My hospitals">
        {me.isPending && <Spinner />}
        <ErrorMessage error={me.error} />
        {me.data?.clinics.length === 0 && (
          <p className="text-sm text-slate-600">
            You haven&apos;t added a hospital yet. Scan the QR code at the reception or enter the
            hospital code below.
          </p>
        )}
        <ul className="divide-y divide-slate-100">
          {me.data?.clinics.map((c) => (
            <li key={c.code}>
              <Link
                to={`/clinic/${c.code}`}
                className="flex items-center justify-between py-3 text-sm"
              >
                <span className="font-medium text-slate-900">{c.name}</span>
                <span className="text-brand-700">Open →</span>
              </Link>
            </li>
          ))}
        </ul>
        {me.data && <p className="mt-2 text-xs text-slate-500">Signed in as {me.data.phone}</p>}
      </Card>
      <Card title="Add a hospital">
        <ErrorMessage error={join.error} />
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            join.mutate();
          }}
        >
          <Input
            aria-label="Hospital code"
            placeholder="Hospital code (ask the reception)"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <Button type="submit" disabled={join.isPending}>
            Add
          </Button>
        </form>
        <p className="mt-2 text-xs text-slate-500">You need the code only once per hospital.</p>
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ one hospital
function ClinicPage() {
  const { code } = useParams();
  const auth = usePatientAuth();
  const qc = useQueryClient();
  const base = `/public/clinics/${encodeURIComponent(code)}`;
  const clinic = useQuery({
    queryKey: ['clinic', code],
    queryFn: () => patientFetch(base, { auth: false }),
    retry: false,
  });
  const me = useQuery({
    queryKey: ['clinic-me', code],
    queryFn: async () => {
      try {
        return await patientFetch(`${base}/me`);
      } catch (err) {
        // Arriving from the hospital's QR link counts as entering its code: join automatically.
        if (err.status !== 403) throw err;
        await patientFetch('/patient/clinics', { method: 'POST', body: { code } });
        qc.invalidateQueries({ queryKey: ['patient-me'] });
        return patientFetch(`${base}/me`);
      }
    },
    enabled: auth.status === 'authenticated' && Boolean(clinic.data?.privacyNotice),
  });
  const [tab, setTab] = useState('book');

  if (clinic.isPending || auth.status === 'loading') return <Spinner />;
  if (clinic.error) return <ErrorMessage error={clinic.error} />;
  const c = clinic.data;
  return (
    <>
      <div className="text-center">
        <h1 className="text-xl font-bold text-slate-900">{c.organization.name}</h1>
        <p className="text-sm text-slate-600">{c.branches.map((b) => b.name).join(' · ')}</p>
      </div>
      {!c.privacyNotice && (
        <Alert tone="amber">Online services are not open yet. Please ask at the reception.</Alert>
      )}
      {c.privacyNotice && auth.status === 'anonymous' && <SignIn title="Sign in to continue" />}
      {c.privacyNotice && auth.status === 'authenticated' && (
        <>
          {me.isPending && <Spinner />}
          <ErrorMessage error={me.error} />
          {me.data && (
            <>
              <div className="flex gap-2" role="tablist">
                {[
                  ['book', 'Book'],
                  ['appointments', 'My appointments'],
                  ['family', 'Family & privacy'],
                ].map(([k, label]) => (
                  <Button
                    key={k}
                    role="tab"
                    aria-selected={tab === k}
                    size="sm"
                    variant={tab === k ? 'primary' : 'secondary'}
                    onClick={() => setTab(k)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              {tab === 'book' && (
                <Book
                  base={base}
                  code={code}
                  profiles={me.data.patients}
                  onBooked={() => setTab('appointments')}
                  goFamily={() => setTab('family')}
                />
              )}
              {tab === 'appointments' && <Appointments base={base} code={code} />}
              {tab === 'family' && <Family base={base} code={code} clinic={c} me={me.data} />}
            </>
          )}
        </>
      )}
    </>
  );
}

const newKey = () =>
  (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, '');

function Book({ base, code, profiles, onBooked, goFamily }) {
  const qc = useQueryClient();
  const bookable = profiles.filter((p) => p.authorizationStatus === 'authorized');
  const [patientId, setPatientId] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [date, setDate] = useState(todayIst());
  const [slot, setSlot] = useState(null);
  const [key, setKey] = useState(newKey);
  const doctors = useQuery({
    queryKey: ['clinic-doctors', code],
    queryFn: () => patientFetch(`${base}/doctors`),
  });
  const doctor = doctorId || doctors.data?.data[0]?.id || '';
  const who = patientId || bookable[0]?.id || '';
  const slots = useQuery({
    queryKey: ['clinic-slots', code, doctor, date],
    queryFn: () => patientFetch(`${base}/doctors/${doctor}/slots?date=${date}`),
    enabled: Boolean(doctor && date),
  });
  const book = useMutation({
    mutationFn: () =>
      patientFetch(`${base}/appointments`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: { patientId: who, doctorId: doctor, slotStart: slot.start },
      }),
    onSuccess: () => {
      setKey(newKey());
      setSlot(null);
      qc.invalidateQueries({ queryKey: ['clinic-appointments', code] });
      qc.invalidateQueries({ queryKey: ['clinic-slots', code] });
      onBooked();
    },
  });

  if (bookable.length === 0) {
    return (
      <Card title="Book an appointment">
        <p className="text-sm text-slate-600">
          First add your profile (and family members) under Family &amp; privacy.
        </p>
        <Button className="mt-3" onClick={goFamily}>
          Add my profile
        </Button>
      </Card>
    );
  }
  return (
    <Card title="Book an appointment">
      <div className="space-y-3">
        <Field label="For" htmlFor="bfor">
          <Select id="bfor" value={who} onChange={(e) => setPatientId(e.target.value)}>
            {bookable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName}{' '}
                {p.relationship === 'self' ? '(me)' : `(${RELATIONSHIP_LABEL[p.relationship]})`}
              </option>
            ))}
          </Select>
        </Field>
        {profiles.some((p) => p.authorizationStatus === 'pending') && (
          <p className="text-xs text-slate-500">
            Family members awaiting the hospital&apos;s check can be booked after their next visit.
          </p>
        )}
        <Field label="Doctor" htmlFor="bdoc">
          <Select
            id="bdoc"
            value={doctor}
            onChange={(e) => (setDoctorId(e.target.value), setSlot(null))}
          >
            {doctors.data?.data.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.specialization ? ` · ${d.specialization}` : ''} · {d.branch}
              </option>
            ))}
          </Select>
        </Field>
        {doctors.data?.data.length === 0 && (
          <p className="text-sm text-slate-500">Online booking isn&apos;t available right now.</p>
        )}
        <Field label="Date" htmlFor="bdate">
          <Input
            id="bdate"
            type="date"
            min={todayIst()}
            value={date}
            onChange={(e) => (setDate(e.target.value), setSlot(null))}
          />
        </Field>
        {slots.isPending && doctor && <Spinner />}
        {slots.data && slots.data.slots.length === 0 && (
          <p className="text-sm text-slate-500">
            {slots.data.open === false
              ? 'This date is not open for booking.'
              : 'No free times on this date.'}
          </p>
        )}
        <div className="grid grid-cols-4 gap-1">
          {slots.data?.slots
            .filter((s) => new Date(s.start) > new Date())
            .map((s) => (
              <button
                key={s.start}
                type="button"
                onClick={() => setSlot(s)}
                className={`rounded border px-1 py-2 text-xs ${slot?.start === s.start ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white'}`}
              >
                {timeOf(s.start)}
              </button>
            ))}
        </div>
        <ErrorMessage error={book.error} />
        <Button className="w-full" disabled={!slot || book.isPending} onClick={() => book.mutate()}>
          {slot ? `Book ${timeOf(slot.start)}` : 'Choose a time'}
        </Button>
      </div>
    </Card>
  );
}

function Appointments({ base, code }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['clinic-appointments', code],
    queryFn: () => patientFetch(`${base}/appointments`),
  });
  const cancel = useMutation({
    mutationFn: (id) => patientFetch(`${base}/appointments/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['clinic-appointments', code] }),
  });
  return (
    <Card title="My appointments">
      {list.isPending && <Spinner />}
      <ErrorMessage error={list.error || cancel.error} />
      {list.data?.data.length === 0 && (
        <p className="text-sm text-slate-500">No appointments yet.</p>
      )}
      <ul className="divide-y divide-slate-100">
        {list.data?.data.map((a) => {
          const [label, tone] = QUEUE_STATUS[a.queueStatus ?? 'booked'];
          const upcoming = ['booked', 'checked_in'].includes(a.status);
          return (
            <li key={a.id} className="py-3 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium">
                    {new Date(`${a.date}T00:00:00`).toLocaleDateString('en-IN', {
                      weekday: 'short',
                      day: 'numeric',
                      month: 'short',
                    })}{' '}
                    · {timeOf(a.slotStart)}
                  </p>
                  <p className="text-slate-600">
                    {a.patient.fullName} · {a.doctor}
                  </p>
                  {a.token && upcoming && <p className="text-slate-600">Token {a.token}</p>}
                </div>
                <Badge tone={tone}>{a.status === 'cancelled' ? 'Cancelled' : label}</Badge>
              </div>
              {upcoming && (
                <div className="mt-2 flex gap-2">
                  <Link
                    to={`/track/${a.trackingCode}`}
                    className="rounded-lg bg-brand-700 px-3 py-1.5 text-xs font-medium text-white"
                  >
                    Track live queue
                  </Link>
                  {a.status === 'booked' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        window.confirm('Cancel this appointment?') && cancel.mutate(a.id)
                      }
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
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

function Family({ base, code, clinic, me }) {
  const qc = useQueryClient();
  const patients = me.patients;
  const [adding, setAdding] = useState(patients.length === 0);
  const [form, setForm] = useState({
    ...NEW,
    relationship: patients.some((p) => p.relationship === 'self') ? 'child' : 'self',
  });
  const [request, setRequest] = useState(null);
  const set = (k) => (e) =>
    setForm((f) => ({
      ...f,
      [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
    }));
  const refresh = () => qc.invalidateQueries({ queryKey: ['clinic-me', code] });
  const register = useMutation({
    mutationFn: () =>
      patientFetch(`${base}/patients`, {
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
      }),
    onSuccess: () => {
      setAdding(false);
      setForm({ ...NEW, relationship: 'child' });
      refresh();
    },
  });
  const consent = useMutation({
    mutationFn: ({ id, key, value }) =>
      patientFetch(`${base}/patients/${id}/consents`, { method: 'POST', body: { [key]: value } }),
    onSuccess: refresh,
  });
  const privacy = useMutation({
    mutationFn: () =>
      patientFetch(`${base}/patients/${request.patientId}/privacy-requests`, {
        method: 'POST',
        body: { requestType: request.requestType, details: request.details },
      }),
    onSuccess: () => setRequest(null),
  });

  return (
    <>
      <Card title={`Profiles on ${me.phone}`}>
        <ErrorMessage error={consent.error} />
        {privacy.isSuccess && <Alert tone="green">Your request was sent to the hospital.</Alert>}
        {patients.length === 0 && <p className="text-sm text-slate-500">No profiles yet.</p>}
        <ul className="divide-y divide-slate-100">
          {patients.map((p) => (
            <li key={p.id} className="py-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span>
                  <span className="font-medium">{p.fullName}</span>{' '}
                  <span className="text-slate-500">
                    ({p.relationship === 'self' ? 'Me' : RELATIONSHIP_LABEL[p.relationship]})
                  </span>
                  {p.patientNumber && (
                    <span className="block text-xs text-slate-500">{p.patientNumber}</span>
                  )}
                </span>
                <Badge tone={p.authorizationStatus === 'authorized' ? 'green' : 'amber'}>
                  {p.authorizationStatus === 'authorized' ? 'Active' : 'Awaiting hospital check'}
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
                        onChange={(e) => consent.mutate({ id: p.id, key, value: e.target.checked })}
                      />
                      {CONSENT_LABEL[purpose]}
                    </label>
                  ))}
                  <button
                    type="button"
                    className="text-xs text-brand-700 underline"
                    onClick={() =>
                      setRequest({ patientId: p.id, requestType: 'access', details: '' })
                    }
                  >
                    Ask the hospital about this person&apos;s data
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {!adding && (
          <Button className="mt-3" variant="secondary" onClick={() => setAdding(true)}>
            Add a family member
          </Button>
        )}
      </Card>
      {request && (
        <Card title="Privacy request">
          <ErrorMessage error={privacy.error} />
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              privacy.mutate();
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
              aria-label="Details"
              required
              minLength={3}
              placeholder="What would you like?"
              value={request.details}
              onChange={(e) => setRequest({ ...request, details: e.target.value })}
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={privacy.isPending}>
                Send
              </Button>
              <Button variant="ghost" onClick={() => setRequest(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
      {adding && (
        <Card title={patients.length ? 'Add a family member' : 'Add my profile'}>
          <ErrorMessage error={register.error} />
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              register.mutate();
            }}
          >
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
              <Field label="This person is" htmlFor="fr">
                <Select id="fr" value={form.relationship} onChange={set('relationship')}>
                  {RELATIONSHIPS.map(([k, v]) => (
                    <option key={k} value={k}>
                      {k === 'self' ? 'Me' : `My ${v.toLowerCase()}`}
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
              Appointment updates on WhatsApp
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.smsService} onChange={set('smsService')} />
              Appointment updates by SMS
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.marketing} onChange={set('marketing')} />
              Health camps and offers
            </label>
            <p className="text-xs text-slate-500">
              Family members are confirmed by the hospital at the next visit before they can be
              booked online.
            </p>
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={register.isPending || !form.privacyNoticeAcknowledged}
              >
                Save
              </Button>
              {patients.length > 0 && (
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

export function PatientApp() {
  return (
    <PatientAuthProvider>
      <Routes>
        <Route path="/track/:code" element={<TrackPage />} />
        <Route
          path="/clinic/:code"
          element={
            <Shell>
              <ClinicPage />
            </Shell>
          }
        />
        <Route
          path="/"
          element={
            <Shell>
              <HomePage />
            </Shell>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </PatientAuthProvider>
  );
}

export default PatientApp;
