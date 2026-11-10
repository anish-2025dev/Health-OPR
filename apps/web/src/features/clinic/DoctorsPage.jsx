import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { formatDate } from '@/features/patients/format';
import { DAYS } from './format';

const NEW_DOCTOR = {
  displayName: '',
  specialization: '',
  branchId: '',
  userId: '',
  consultationMinutes: 10,
  bookingWindowDays: 14,
  onlineBookingEnabled: true,
};

export function DoctorsPage() {
  const auth = useAuth();
  const canManage = auth.can('doctors.manage');
  const qc = useQueryClient();
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState(null);
  const doctors = useQuery({
    queryKey: ['doctors', 'all'],
    queryFn: () => apiFetch('/doctors?status=all'),
  });
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => apiFetch('/branches') });
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => apiFetch('/users'),
    enabled: canManage && auth.can('users.read'),
  });
  const save = useMutation({
    mutationFn: (f) =>
      apiFetch(f.id ? `/doctors/${f.id}` : '/doctors', {
        method: f.id ? 'PATCH' : 'POST',
        body: {
          displayName: f.displayName,
          specialization: f.specialization || null,
          branchId: f.branchId || branches.data?.data[0]?.id,
          userId: f.userId || null,
          consultationMinutes: Number(f.consultationMinutes),
          bookingWindowDays: Number(f.bookingWindowDays),
          onlineBookingEnabled: f.onlineBookingEnabled,
          ...(f.id ? { status: f.status } : {}),
        },
      }),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['doctors'] });
      setForm(null);
      setSelected(d.id);
    },
  });

  const edit = (d) =>
    setForm({
      id: d.id,
      displayName: d.displayName,
      specialization: d.specialization ?? '',
      branchId: d.branch.id,
      userId: d.userId ?? '',
      consultationMinutes: d.consultationMinutes,
      bookingWindowDays: d.bookingWindowDays,
      onlineBookingEnabled: d.onlineBookingEnabled,
      status: d.status,
    });
  const doctor = doctors.data?.data.find((d) => d.id === selected);

  return (
    <>
      <PageHeader
        title="Doctors"
        description="Doctor profiles, weekly consultation hours and days off."
        actions={canManage && <Button onClick={() => setForm(NEW_DOCTOR)}>Add doctor</Button>}
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card title="Doctors">
          {doctors.isPending && <Spinner />}
          <ErrorMessage error={doctors.error} />
          {doctors.data?.data.length === 0 && (
            <p className="text-sm text-slate-500">No doctors yet.</p>
          )}
          <ul className="divide-y divide-slate-100">
            {doctors.data?.data.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => (setSelected(d.id), setForm(null))}
                  className={`w-full rounded-lg px-2 py-2 text-left text-sm ${selected === d.id ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
                >
                  <span className="font-medium">{d.displayName}</span>
                  {d.status !== 'active' && (
                    <span className="ml-2">
                      <Badge>inactive</Badge>
                    </span>
                  )}
                  <span className="block text-xs text-slate-500">
                    {d.specialization ?? 'General'} · {d.branch.name} · {d.consultationMinutes} min
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        <div className="space-y-6">
          {form && (
            <Card title={form.id ? 'Edit doctor' : 'New doctor'}>
              <ErrorMessage error={save.error} />
              <form
                className="mt-2 grid gap-3 sm:grid-cols-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  save.mutate(form);
                }}
              >
                <Field label="Name shown to patients" htmlFor="dn">
                  <Input
                    id="dn"
                    required
                    value={form.displayName}
                    onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                  />
                </Field>
                <Field label="Specialization" htmlFor="ds">
                  <Input
                    id="ds"
                    value={form.specialization}
                    onChange={(e) => setForm({ ...form, specialization: e.target.value })}
                  />
                </Field>
                <Field label="Branch" htmlFor="db">
                  <Select
                    id="db"
                    value={form.branchId || branches.data?.data[0]?.id || ''}
                    onChange={(e) => setForm({ ...form, branchId: e.target.value })}
                  >
                    {branches.data?.data.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Login account (optional)"
                  htmlFor="du"
                  hint="Lets the doctor run their own queue"
                >
                  <Select
                    id="du"
                    value={form.userId}
                    onChange={(e) => setForm({ ...form, userId: e.target.value })}
                  >
                    <option value="">None</option>
                    {users.data?.data
                      .filter((u) => u.email)
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.fullName} ({u.email})
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field
                  label="Typical consultation (minutes)"
                  htmlFor="dc"
                  hint="Used for wait estimates until real timings are available"
                >
                  <Input
                    id="dc"
                    type="number"
                    min="2"
                    max="240"
                    value={form.consultationMinutes}
                    onChange={(e) => setForm({ ...form, consultationMinutes: e.target.value })}
                  />
                </Field>
                <Field label="Online booking up to (days ahead)" htmlFor="dw">
                  <Input
                    id="dw"
                    type="number"
                    min="0"
                    max="180"
                    value={form.bookingWindowDays}
                    onChange={(e) => setForm({ ...form, bookingWindowDays: e.target.value })}
                  />
                </Field>
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={form.onlineBookingEnabled}
                    onChange={(e) => setForm({ ...form, onlineBookingEnabled: e.target.checked })}
                  />
                  Patients can book online and on WhatsApp
                </label>
                {form.id && (
                  <Field label="Status" htmlFor="dst">
                    <Select
                      id="dst"
                      value={form.status}
                      onChange={(e) => setForm({ ...form, status: e.target.value })}
                    >
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </Select>
                  </Field>
                )}
                <div className="flex gap-2 sm:col-span-2">
                  <Button type="submit" disabled={save.isPending}>
                    Save
                  </Button>
                  <Button variant="ghost" onClick={() => setForm(null)}>
                    Cancel
                  </Button>
                </div>
              </form>
            </Card>
          )}
          {!form && doctor && (
            <>
              <Card
                title={doctor.displayName}
                actions={
                  canManage && (
                    <Button size="sm" variant="secondary" onClick={() => edit(doctor)}>
                      Edit
                    </Button>
                  )
                }
              >
                <p className="text-sm text-slate-600">
                  {doctor.specialization ?? 'General'} · {doctor.branch.name} · online booking{' '}
                  {doctor.onlineBookingEnabled
                    ? `up to ${doctor.bookingWindowDays} days ahead`
                    : 'off'}
                </p>
              </Card>
              <ScheduleEditor doctor={doctor} canManage={canManage} />
              <TimeOff doctor={doctor} canManage={canManage} />
            </>
          )}
          {!form && !doctor && (
            <p className="text-sm text-slate-500">Select a doctor to see their hours.</p>
          )}
        </div>
      </div>
    </>
  );
}

function ScheduleEditor({ doctor, canManage }) {
  const qc = useQueryClient();
  const schedule = useQuery({
    queryKey: ['doctor-schedule', doctor.id],
    queryFn: () => apiFetch(`/doctors/${doctor.id}/schedule`),
  });
  const [rows, setRows] = useState(null);
  const current = rows ?? schedule.data?.data ?? [];
  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/doctors/${doctor.id}/schedule`, {
        method: 'PUT',
        body: {
          sessions: current.map((r) => ({
            ...r,
            dayOfWeek: Number(r.dayOfWeek),
            slotMinutes: Number(r.slotMinutes),
            patientsPerSlot: Number(r.patientsPerSlot),
          })),
        },
      }),
    onSuccess: () => {
      setRows(null);
      qc.invalidateQueries({ queryKey: ['doctor-schedule', doctor.id] });
    },
  });
  const update = (i, k, v) => setRows(current.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  return (
    <Card title="Weekly consultation hours">
      {schedule.isPending && <Spinner />}
      <ErrorMessage error={save.error} />
      {current.length === 0 && !schedule.isPending && (
        <p className="mb-2 text-sm text-slate-500">No hours set; patients can&apos;t book yet.</p>
      )}
      <div className="space-y-2">
        {current.map((r, i) => (
          <div
            key={i}
            className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-[90px_1fr_1fr_1fr_1fr_auto]"
          >
            <Select
              aria-label="Day"
              disabled={!canManage}
              value={r.dayOfWeek}
              onChange={(e) => update(i, 'dayOfWeek', e.target.value)}
            >
              {DAYS.map((d, n) => (
                <option key={d} value={n}>
                  {d}
                </option>
              ))}
            </Select>
            <Input
              aria-label="From"
              type="time"
              disabled={!canManage}
              value={r.startTime}
              onChange={(e) => update(i, 'startTime', e.target.value)}
            />
            <Input
              aria-label="To"
              type="time"
              disabled={!canManage}
              value={r.endTime}
              onChange={(e) => update(i, 'endTime', e.target.value)}
            />
            <Input
              aria-label="Slot minutes"
              type="number"
              min="5"
              title="Slot length (minutes)"
              disabled={!canManage}
              value={r.slotMinutes}
              onChange={(e) => update(i, 'slotMinutes', e.target.value)}
            />
            <Input
              aria-label="Patients per slot"
              type="number"
              min="1"
              title="Patients per slot"
              disabled={!canManage}
              value={r.patientsPerSlot}
              onChange={(e) => update(i, 'patientsPerSlot', e.target.value)}
            />
            {canManage && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRows(current.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            )}
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Columns: day · from · to · slot minutes · patients per slot
      </p>
      {canManage && (
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              setRows([
                ...current,
                {
                  dayOfWeek: 1,
                  startTime: '10:00',
                  endTime: '13:00',
                  slotMinutes: 15,
                  patientsPerSlot: 1,
                },
              ])
            }
          >
            Add session
          </Button>
          {rows && (
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              Save hours
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function TimeOff({ doctor, canManage }) {
  const qc = useQueryClient();
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const list = useQuery({
    queryKey: ['time-off', doctor.id],
    queryFn: () => apiFetch(`/doctors/${doctor.id}/time-off`),
  });
  const add = useMutation({
    mutationFn: () =>
      apiFetch(`/doctors/${doctor.id}/time-off`, {
        method: 'POST',
        body: { date, reason: reason || undefined },
      }),
    onSuccess: () => {
      setDate('');
      setReason('');
      qc.invalidateQueries({ queryKey: ['time-off', doctor.id] });
    },
  });
  const remove = useMutation({
    mutationFn: (id) => apiFetch(`/doctors/${doctor.id}/time-off/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['time-off', doctor.id] }),
  });
  return (
    <Card title="Days off">
      <ErrorMessage error={add.error || remove.error} />
      {add.data?.affectedAppointments > 0 && (
        <Alert tone="amber">
          {add.data.affectedAppointments} patient(s) are already booked that day. Contact them to
          reschedule.
        </Alert>
      )}
      <ul className="mb-3 space-y-1 text-sm">
        {list.data?.data.map((o) => (
          <li key={o.id} className="flex items-center justify-between">
            <span>
              {formatDate(o.date)} {o.reason ? `· ${o.reason}` : ''}
            </span>
            {canManage && (
              <Button size="sm" variant="ghost" onClick={() => remove.mutate(o.id)}>
                Remove
              </Button>
            )}
          </li>
        ))}
        {list.data?.data.length === 0 && <li className="text-slate-500">None planned.</li>}
      </ul>
      {canManage && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Input
            aria-label="Date off"
            type="date"
            required
            className="w-44"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <Input
            aria-label="Reason"
            placeholder="Reason (optional)"
            className="w-56"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button type="submit" size="sm" variant="secondary">
            Add day off
          </Button>
        </form>
      )}
    </Card>
  );
}
