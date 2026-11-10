import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/features/auth/auth-context';
import {
  Alert,
  Badge,
  Button,
  Card,
  ErrorMessage,
  Input,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui';
import {
  CLINIC_TZ,
  PRIORITY,
  QUEUE_STATUS,
  timeOf,
  todayIst,
  trackingUrl,
  waitText,
} from './format';

const REFRESH_MS = 5000;
const newKey = () =>
  (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, '');

/** Doctors this user can run a queue for (a doctor sees only their own). */
function useMyDoctors() {
  const auth = useAuth();
  const doctors = useQuery({ queryKey: ['doctors'], queryFn: () => apiFetch('/doctors') });
  const onlyDoctor =
    !auth.can('appointments.manage') && auth.me.roles.some((r) => r.role === 'doctor');
  const list = (doctors.data?.data ?? []).filter(
    (d) => !onlyDoctor || d.userId === auth.me.user.id,
  );
  return { ...doctors, list };
}

// ------------------------------------------------------------------ reception desk + queue
export function ReceptionPage() {
  const auth = useAuth();
  const canManage = auth.can('appointments.manage');
  const [params, setParams] = useSearchParams();
  const doctors = useMyDoctors();
  const doctorId = params.get('doctor') || doctors.list[0]?.id || '';
  const date = params.get('date') || todayIst();
  const set = (k, v) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title={canManage ? 'Reception' : 'My queue'}
        description="Book appointments, add walk-ins and run the live queue. Updates every few seconds."
        actions={
          doctorId && (
            <Link
              to={`/queue-display/${doctorId}`}
              target="_blank"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700"
            >
              Open waiting-room display
            </Link>
          )
        }
      />
      {doctors.isPending && <Spinner />}
      {doctors.data && doctors.list.length === 0 && (
        <Alert tone="amber">
          No doctors are set up{canManage ? '' : ' for your login'}. Add doctors and their hours
          under Doctors.
        </Alert>
      )}
      {doctorId && (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            <Select
              aria-label="Doctor"
              className="w-64"
              value={doctorId}
              onChange={(e) => set('doctor', e.target.value)}
            >
              {doctors.list.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.displayName}
                </option>
              ))}
            </Select>
            <Input
              aria-label="Date"
              type="date"
              className="w-44"
              value={date}
              onChange={(e) => set('date', e.target.value)}
            />
          </div>
          <div className={canManage ? 'grid gap-6 xl:grid-cols-[380px_1fr]' : ''}>
            {canManage && (
              <BookingPanel
                doctorId={doctorId}
                date={date}
                initialPatientId={params.get('patientId')}
              />
            )}
            <QueueBoard doctorId={doctorId} date={date} />
          </div>
        </>
      )}
    </>
  );
}

function PatientPicker({ value, onChange, initialPatientId }) {
  const [q, setQ] = useState('');
  const term = q.trim();
  const isPhone = /^\+?[\d\s-]{4,}$/.test(term);
  const results = useQuery({
    queryKey: ['patient-pick', term],
    queryFn: () =>
      apiFetch(
        `/patients?${new URLSearchParams(isPhone ? { phone: term, limit: '10' } : { q: term, limit: '10' })}`,
      ),
    enabled: term.length >= 2,
    placeholderData: keepPreviousData,
  });
  const preset = useQuery({
    queryKey: ['patient', initialPatientId],
    queryFn: () => apiFetch(`/patients/${initialPatientId}`),
    enabled: Boolean(initialPatientId) && !value,
  });
  useEffect(() => {
    if (preset.data && !value) onChange(preset.data);
  }, [preset.data, value, onChange]);

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
        <span>
          <span className="font-medium">{value.fullName}</span>{' '}
          <span className="text-slate-500">{value.patientNumber}</span>
        </span>
        <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
          Change
        </Button>
      </div>
    );
  }
  return (
    <div>
      <Input
        aria-label="Find patient"
        placeholder="Name, patient number or phone"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {term.length >= 2 && (
        <ul className="mt-1 max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 bg-white text-sm">
          {results.data?.data.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left hover:bg-slate-50"
                onClick={() => onChange(p)}
              >
                {p.fullName} <span className="text-xs text-slate-500">{p.patientNumber}</span>
                <span className="block text-xs text-slate-500">
                  {p.contacts.map((c) => c.phone).join(', ')}
                </span>
              </button>
            </li>
          ))}
          {results.data?.data.length === 0 && (
            <li className="px-3 py-2 text-slate-500">
              Not found.{' '}
              <Link className="text-brand-700 underline" to="/patients/new">
                Register a new patient
              </Link>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function BookingPanel({ doctorId, date, initialPatientId }) {
  const qc = useQueryClient();
  const [patient, setPatient] = useState(null);
  const [slot, setSlot] = useState(null);
  const [priority, setPriority] = useState('0');
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(null);
  const [key, setKey] = useState(newKey);
  const isToday = date === todayIst();
  const slots = useQuery({
    queryKey: ['slots', doctorId, date],
    queryFn: () => apiFetch(`/doctors/${doctorId}/slots?date=${date}`),
  });
  const after = (r) => {
    setDone(r);
    setPatient(null);
    setSlot(null);
    setKey(newKey());
    setPriority('0');
    setReason('');
    qc.invalidateQueries({ queryKey: ['slots', doctorId, date] });
    qc.invalidateQueries({ queryKey: ['queue', doctorId, date] });
  };
  const book = useMutation({
    mutationFn: () =>
      apiFetch('/appointments', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: { patientId: patient.id, doctorId, slotStart: slot.start, overbook: !slot.available },
      }),
    onSuccess: (a) =>
      after({
        token: a.queue.token,
        name: a.patient.fullName,
        code: a.queue.trackingCode,
        time: a.slotStart,
      }),
  });
  const walkIn = useMutation({
    mutationFn: () =>
      apiFetch('/queue/walk-ins', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: {
          patientId: patient.id,
          doctorId,
          priority: Number(priority),
          ...(priority !== '0' ? { priorityReason: reason } : {}),
        },
      }),
    onSuccess: (e) => after({ token: e.token, name: e.patient.fullName, code: e.trackingCode }),
  });

  return (
    <Card title="New booking">
      <div className="space-y-3">
        {done && (
          <Alert tone="green">
            Token <strong>{done.token}</strong> for {done.name}
            {done.time ? ` at ${timeOf(done.time)}` : ''}.{' '}
            <button
              type="button"
              className="underline"
              onClick={() => navigator.clipboard?.writeText(trackingUrl(done.code))}
            >
              Copy live tracking link
            </button>
          </Alert>
        )}
        <PatientPicker value={patient} onChange={setPatient} initialPatientId={initialPatientId} />
        <ErrorMessage error={book.error || walkIn.error || slots.error} />
        {slots.data?.timeOff !== null && slots.data?.timeOff !== undefined && (
          <Alert tone="amber">
            Doctor is off this day ({slots.data.timeOff || 'no reason given'}).
          </Alert>
        )}
        <div>
          <p className="mb-1 text-xs font-medium text-slate-500 uppercase">Appointment slot</p>
          {slots.isPending && <Spinner />}
          {slots.data?.slots.length === 0 && slots.data?.timeOff === null && (
            <p className="text-sm text-slate-500">No consultation hours on this day.</p>
          )}
          <div className="grid max-h-52 grid-cols-4 gap-1 overflow-y-auto">
            {slots.data?.slots
              .filter((s) => new Date(s.start) > new Date())
              .map((s) => (
                <button
                  key={s.start}
                  type="button"
                  onClick={() => setSlot(s)}
                  title={`${s.booked}/${s.capacity} booked`}
                  className={`rounded border px-1 py-1 text-xs ${
                    slot?.start === s.start
                      ? 'border-brand-700 bg-brand-700 text-white'
                      : s.available
                        ? 'border-slate-300 hover:bg-slate-50'
                        : 'border-slate-200 bg-slate-100 text-slate-400'
                  }`}
                >
                  {s.time}
                </button>
              ))}
          </div>
          {slot && !slot.available && (
            <p className="mt-1 text-xs text-amber-700">
              This slot is full; booking it will overbook.
            </p>
          )}
        </div>
        <Button
          className="w-full"
          disabled={!patient || !slot || book.isPending}
          onClick={() => book.mutate()}
        >
          Book appointment
        </Button>
        {isToday && (
          <div className="space-y-2 border-t border-slate-100 pt-3">
            <p className="text-xs font-medium text-slate-500 uppercase">Walk-in (now)</p>
            <Select
              aria-label="Priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            >
              {Object.entries(PRIORITY).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            {priority !== '0' && (
              <Input
                aria-label="Priority reason"
                placeholder="Reason for priority"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
            <Button
              className="w-full"
              variant="secondary"
              disabled={
                !patient || walkIn.isPending || (priority !== '0' && reason.trim().length < 3)
              }
              onClick={() => walkIn.mutate()}
            >
              Add walk-in to queue
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function QueueBoard({ doctorId, date }) {
  const auth = useAuth();
  const canManage = auth.can('appointments.manage');
  const qc = useQueryClient();
  const board = useQuery({
    queryKey: ['queue', doctorId, date],
    queryFn: () => apiFetch(`/queue?doctorId=${doctorId}&date=${date}`),
    refetchInterval: REFRESH_MS,
    placeholderData: keepPreviousData,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['queue', doctorId, date] });
  const act = useMutation({
    mutationFn: ({ entry, action, body }) =>
      apiFetch(`/queue/entries/${entry.id}/${action}`, { method: 'POST', body: body ?? {} }),
    onSuccess: refresh,
  });
  const callNext = useMutation({
    mutationFn: () => apiFetch('/queue/call-next', { method: 'POST', body: { doctorId } }),
    onSuccess: refresh,
  });
  const closeDay = useMutation({
    mutationFn: () => apiFetch('/queue/close-day', { method: 'POST', body: { doctorId, date } }),
    onSuccess: refresh,
  });
  const withReason = (entry, action, prompt) => {
    const reason = window.prompt(prompt);
    if (reason)
      act.mutate({
        entry,
        action,
        body: action === 'priority' ? { priority: 2, reason } : { reason },
      });
  };

  if (board.isPending) return <Spinner />;
  if (board.error) return <ErrorMessage error={board.error} />;
  const b = board.data;
  return (
    <Card
      title={`Queue · ${b.doctor.displayName}`}
      actions={
        b.isToday && (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => callNext.mutate()} disabled={callNext.isPending}>
              Call next
            </Button>
            {canManage && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  window.confirm('Mark everyone not seen today as no-show?') && closeDay.mutate()
                }
              >
                Close day
              </Button>
            )}
          </div>
        )
      }
    >
      <div className="mb-3 flex flex-wrap gap-4 text-sm">
        <span>
          Now serving: <strong className="text-lg">{b.nowServingToken ?? '—'}</strong>
        </span>
        <span>Waiting: {b.counts.waiting}</span>
        <span>Not arrived: {b.counts.booked}</span>
        <span>Done: {b.counts.completed}</span>
        <span>No-show: {b.counts.noShow}</span>
        <span className="text-slate-500">≈ {b.averageConsultationMinutes} min per patient</span>
      </div>
      <ErrorMessage error={act.error || callNext.error || closeDay.error} />
      {b.entries.length === 0 && (
        <p className="text-sm text-slate-500">No bookings for this day.</p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500 uppercase">
            <tr>
              <th className="py-2 pr-3">Token</th>
              <th className="py-2 pr-3">Patient</th>
              <th className="py-2 pr-3">Slot</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {b.entries.map((e) => {
              const [label, tone] = QUEUE_STATUS[e.status];
              const btn = (action, text, variant = 'secondary') => (
                <Button
                  size="sm"
                  variant={variant}
                  onClick={() => act.mutate({ entry: e, action })}
                >
                  {text}
                </Button>
              );
              return (
                <tr
                  key={e.id}
                  className={
                    ['completed', 'cancelled', 'no_show'].includes(e.status) ? 'text-slate-400' : ''
                  }
                >
                  <td className="py-2 pr-3 text-lg font-semibold">{e.token}</td>
                  <td className="py-2 pr-3">
                    <Link to={`/patients/${e.patient.id}`} className="font-medium text-brand-700">
                      {e.patient.fullName}
                    </Link>
                    <span className="block text-xs text-slate-500">
                      {e.kind === 'walk_in' ? 'Walk-in' : 'Appointment'}
                      {e.priority > 0 && ` · ${PRIORITY[e.priority]}`}
                    </span>
                  </td>
                  <td className="py-2 pr-3">{e.slotStart ? timeOf(e.slotStart) : '—'}</td>
                  <td className="py-2 pr-3">
                    <Badge tone={tone}>{label}</Badge>
                  </td>
                  <td className="py-2">
                    {b.isToday && (
                      <div className="flex flex-wrap gap-1">
                        {e.status === 'booked' && btn('check-in', 'Arrived', 'primary')}
                        {['waiting', 'called'].includes(e.status) &&
                          btn('call', e.status === 'called' ? 'Call again' : 'Call')}
                        {['waiting', 'called'].includes(e.status) && btn('start', 'Start')}
                        {['called', 'in_consultation'].includes(e.status) &&
                          btn('complete', 'Done', 'primary')}
                        {['booked', 'waiting', 'called'].includes(e.status) &&
                          btn('no-show', 'No-show', 'ghost')}
                        {['called', 'no_show'].includes(e.status) &&
                          btn('requeue', 'Back to queue', 'ghost')}
                        {canManage &&
                          ['booked', 'waiting', 'called', 'in_consultation'].includes(e.status) &&
                          e.priority < 2 && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                withReason(e, 'priority', 'Why does this patient need priority?')
                              }
                            >
                              Prioritize
                            </Button>
                          )}
                        {canManage && ['booked', 'waiting', 'called'].includes(e.status) && (
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => withReason(e, 'cancel', 'Reason for cancelling')}
                          >
                            Cancel
                          </Button>
                        )}
                      </div>
                    )}
                    {!b.isToday && canManage && e.status === 'booked' && e.appointmentId && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          const reason = window.prompt('Reason for cancelling');
                          if (reason)
                            apiFetch(`/appointments/${e.appointmentId}/cancel`, {
                              method: 'POST',
                              body: { reason },
                            }).then(refresh);
                        }}
                      >
                        Cancel
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ waiting-room display (tokens only)
export function QueueDisplayPage() {
  const { doctorId } = useParams();
  const board = useQuery({
    queryKey: ['queue', doctorId, 'display'],
    queryFn: () => apiFetch(`/queue?doctorId=${doctorId}`),
    refetchInterval: REFRESH_MS,
  });
  if (board.isPending) return <Spinner />;
  if (board.error) return <ErrorMessage error={board.error} />;
  const b = board.data;
  const next = b.entries.filter((e) => e.status === 'waiting').slice(0, 6);
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-brand-900 p-8 text-white">
      <p className="text-3xl font-semibold">{b.doctor.displayName}</p>
      <div className="text-center">
        <p className="text-2xl text-brand-50/80">Now serving</p>
        <p className="text-[10rem] leading-none font-bold">{b.nowServingToken ?? '—'}</p>
      </div>
      <div className="text-center">
        <p className="text-xl text-brand-50/80">Next</p>
        <p className="mt-2 flex gap-6 text-5xl font-semibold">
          {next.length ? next.map((e) => <span key={e.id}>{e.token}</span>) : '—'}
        </p>
      </div>
      <p className="text-sm text-brand-50/70">
        Waiting times are approximate. Please stay nearby when your token is close.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ clinic dashboard (Phase 7)
export function ClinicDashboardPage() {
  const summary = useQuery({
    queryKey: ['queue-summary'],
    queryFn: () => apiFetch('/queue/summary'),
    refetchInterval: 15000,
  });
  const totals = (summary.data?.data ?? []).reduce(
    (t, r) => ({
      booked:
        t.booked +
        r.counts.booked +
        r.counts.waiting +
        r.counts.called +
        r.counts.inConsultation +
        r.counts.completed +
        r.counts.noShow,
      waiting: t.waiting + r.counts.waiting,
      completed: t.completed + r.counts.completed,
      noShow: t.noShow + r.counts.noShow,
      walkIns: t.walkIns + r.walkIns,
    }),
    { booked: 0, waiting: 0, completed: 0, noShow: 0, walkIns: 0 },
  );
  return (
    <>
      <PageHeader
        title="Clinic today"
        description="Live numbers for each doctor. Refreshes every 15 seconds."
      />
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          ['Patients today', totals.booked],
          ['Waiting now', totals.waiting],
          ['Seen', totals.completed],
          ['No-shows', totals.noShow],
          ['Walk-ins', totals.walkIns],
        ].map(([label, n]) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs text-slate-500">{label}</p>
            <p className="text-2xl font-semibold text-slate-900">{n}</p>
          </div>
        ))}
      </div>
      <Card title="Doctors">
        {summary.isPending && <Spinner />}
        <ErrorMessage error={summary.error} />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-500 uppercase">
              <tr>
                <th className="py-2 pr-3">Doctor</th>
                <th className="py-2 pr-3">Now serving</th>
                <th className="py-2 pr-3">Waiting</th>
                <th className="py-2 pr-3">Not arrived</th>
                <th className="py-2 pr-3">Seen</th>
                <th className="py-2 pr-3">No-show</th>
                <th className="py-2 pr-3">Avg wait</th>
                <th className="py-2">Avg consult</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {summary.data?.data.map((r) => (
                <tr key={r.doctor.id}>
                  <td className="py-2 pr-3">
                    <Link
                      to={`/reception?doctor=${r.doctor.id}`}
                      className="font-medium text-brand-700"
                    >
                      {r.doctor.displayName}
                    </Link>
                    <span className="block text-xs text-slate-500">{r.doctor.branchName}</span>
                  </td>
                  <td className="py-2 pr-3 font-semibold">{r.nowServingToken ?? '—'}</td>
                  <td className="py-2 pr-3">{r.counts.waiting}</td>
                  <td className="py-2 pr-3">{r.counts.booked}</td>
                  <td className="py-2 pr-3">{r.counts.completed}</td>
                  <td className="py-2 pr-3">{r.counts.noShow}</td>
                  <td className="py-2 pr-3">
                    {r.averageWaitMinutes != null ? `${r.averageWaitMinutes} min` : '—'}
                  </td>
                  <td className="py-2">{r.averageConsultationMinutes} min</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ patient's live tracking link
export function TrackPage() {
  const { code } = useParams();
  const status = useQuery({
    queryKey: ['track', code],
    queryFn: () => apiFetch(`/public/track/${encodeURIComponent(code)}`, { auth: false }),
    refetchInterval: 15000,
    retry: false,
  });
  const s = status.data;
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-sm space-y-4">
        {status.isPending && <Spinner />}
        <ErrorMessage error={status.error} />
        {s && (
          <>
            <header className="text-center">
              <p className="text-sm text-slate-500">
                {s.clinic.name} · {s.branch.name}
              </p>
              <p className="text-base font-medium text-slate-800">{s.doctor.name}</p>
            </header>
            <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
              <p className="text-sm text-slate-500">Your token</p>
              <p className="text-7xl font-bold text-brand-700">{s.token}</p>
              <p className="mt-2 text-sm text-slate-600">
                {new Date(`${s.date}T00:00:00`).toLocaleDateString('en-IN', {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                })}
                {s.slotStart ? ` · slot ${timeOf(s.slotStart)}` : ''}
              </p>
              <div className="mt-3">
                <Badge tone={QUEUE_STATUS[s.status][1]}>{QUEUE_STATUS[s.status][0]}</Badge>
              </div>
            </div>
            {s.isToday && ['booked', 'waiting', 'called'].includes(s.status) && (
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-white p-3 shadow-sm">
                  <p className="text-xs text-slate-500">Now serving</p>
                  <p className="text-2xl font-semibold">{s.nowServingToken ?? '—'}</p>
                </div>
                <div className="rounded-xl bg-white p-3 shadow-sm">
                  <p className="text-xs text-slate-500">Ahead of you</p>
                  <p className="text-2xl font-semibold">{s.ahead}</p>
                </div>
                <div className="rounded-xl bg-white p-3 shadow-sm">
                  <p className="text-xs text-slate-500">Approx. wait</p>
                  <p className="text-lg font-semibold">{waitText(s.estimatedWaitMinutes)}</p>
                </div>
              </div>
            )}
            {s.status === 'called' && (
              <Alert tone="green">You have been called. Please go to the doctor.</Alert>
            )}
            {!s.isToday && s.status === 'booked' && (
              <p className="text-center text-sm text-slate-600">
                Live queue status starts on the day of your visit.
              </p>
            )}
            <p className="text-center text-xs text-slate-500">
              Waiting times are estimates and can change (emergencies, longer consultations).
              Updated {new Date(s.updatedAt).toLocaleTimeString('en-IN')}.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
