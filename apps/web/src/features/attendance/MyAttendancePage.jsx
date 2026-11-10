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
  Spinner,
} from '@/components/ui';
import { MarkAttendanceCard } from './MarkAttendanceCard';
import { MonthPicker, MonthView, StatusSelect } from './MonthView';
import { currentMonth, fmtDate } from './format';

function RequestCorrectionForm({ day, onDone }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    checkIn: day.checkIn ?? '',
    checkOut: day.checkOut ?? '',
    status: '',
    reason: '',
  });
  const submit = useMutation({
    mutationFn: () =>
      apiFetch('/me/attendance/regularizations', {
        method: 'POST',
        body: {
          date: day.date,
          ...(form.checkIn && form.checkIn !== day.checkIn ? { checkIn: form.checkIn } : {}),
          ...(form.checkOut && form.checkOut !== day.checkOut ? { checkOut: form.checkOut } : {}),
          ...(form.status ? { status: form.status } : {}),
          reason: form.reason,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['me'] });
      onDone();
    },
  });
  return (
    <Card title={`Request a correction for ${fmtDate(day.date)}`}>
      <form
        className="grid gap-3 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit.mutate();
        }}
      >
        <Field label="Check-in" htmlFor="rc-in">
          <Input
            id="rc-in"
            type="time"
            value={form.checkIn}
            onChange={(e) => setForm({ ...form, checkIn: e.target.value })}
          />
        </Field>
        <Field label="Check-out" htmlFor="rc-out">
          <Input
            id="rc-out"
            type="time"
            value={form.checkOut}
            onChange={(e) => setForm({ ...form, checkOut: e.target.value })}
          />
        </Field>
        <Field label="Status (optional)" htmlFor="rc-status">
          <StatusSelect
            id="rc-status"
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
          />
        </Field>
        <Field label="Reason" htmlFor="rc-reason">
          <Input
            id="rc-reason"
            placeholder="e.g. Forgot to check out"
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
          />
        </Field>
        <div className="flex gap-2 sm:col-span-4">
          <Button type="submit" disabled={submit.isPending || form.reason.trim().length < 5}>
            Send request
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
        <div className="sm:col-span-4">
          <ErrorMessage error={submit.error} />
        </div>
      </form>
    </Card>
  );
}

const REQUEST_TONE = { pending: 'amber', approved: 'green', rejected: 'red', cancelled: 'slate' };

function MyRequests() {
  const queryClient = useQueryClient();
  const requests = useQuery({
    queryKey: ['me', 'regularizations'],
    queryFn: () => apiFetch('/me/attendance/regularizations'),
  });
  const cancel = useMutation({
    mutationFn: (id) => apiFetch(`/me/attendance/regularizations/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });
  if (!requests.data?.data.length) return null;
  return (
    <Card title="My correction requests">
      <ErrorMessage error={cancel.error} />
      <ul className="divide-y divide-slate-100 text-sm">
        {requests.data.data.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              <span className="font-medium">{fmtDate(r.date)}</span>
              <span className="text-slate-500">
                {' '}
                ·{' '}
                {[r.checkIn && `in ${r.checkIn}`, r.checkOut && `out ${r.checkOut}`, r.status]
                  .filter(Boolean)
                  .join(', ')}{' '}
                · {r.reason}
              </span>
              {r.decisionComment && (
                <span className="block text-xs text-slate-500">Reply: {r.decisionComment}</span>
              )}
            </span>
            <span className="flex items-center gap-2">
              <Badge tone={REQUEST_TONE[r.state]}>{r.state}</Badge>
              {r.state === 'pending' && (
                <Button size="sm" variant="ghost" onClick={() => cancel.mutate(r.id)}>
                  Cancel
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function MyAttendancePage() {
  const { me } = useAuth();
  const [month, setMonth] = useState(currentMonth());
  const [correcting, setCorrecting] = useState(null);
  const data = useQuery({
    queryKey: ['me', 'attendance', month],
    queryFn: () => apiFetch(`/me/attendance?month=${month}`),
  });

  return (
    <>
      <PageHeader
        title="My attendance"
        description={`${me.employee.fullName} · ${me.employee.employeeNumber}`}
      />
      <div className="space-y-6">
        <MarkAttendanceCard />
        {correcting && (
          <RequestCorrectionForm day={correcting} onDone={() => setCorrecting(null)} />
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-900">Monthly record</h2>
          <MonthPicker month={month} onChange={setMonth} />
        </div>
        {data.isPending && <Spinner />}
        {data.error && <Alert>{data.error.message}</Alert>}
        {data.data && (
          <MonthView
            data={data.data}
            dayActionLabel="Request correction"
            onDayAction={setCorrecting}
          />
        )}
        <MyRequests />
      </div>
    </>
  );
}
