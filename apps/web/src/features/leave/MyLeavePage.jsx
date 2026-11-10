import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
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
import { fmtDate } from '@/features/attendance/format';

import { REQUEST_TONE } from './format';
const fmtDays = (n) =>
  n === null || n === undefined ? '∞' : Number.isInteger(n) ? String(n) : n.toFixed(1);

export function BalanceCards({ balances }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {balances
        .filter((b) => b.type.status === 'active')
        .map((b) => (
          <div
            key={b.type.id}
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <p className="text-sm font-medium text-slate-700">
              {b.type.name} <span className="text-xs text-slate-400">{b.type.code}</span>
            </p>
            <p className="mt-1 text-2xl font-bold text-brand-700">{fmtDays(b.available)}</p>
            <p className="text-xs text-slate-500">
              available · {fmtDays(b.accrued + b.adjusted)} total · {fmtDays(b.used)} used
              {b.pending ? ` · ${fmtDays(b.pending)} pending` : ''}
            </p>
            {!b.type.isPaid && <Badge tone="amber">unpaid</Badge>}
          </div>
        ))}
    </div>
  );
}

function ApplyForm({ types, onDone }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    leaveTypeId: '',
    startDate: '',
    endDate: '',
    startHalf: false,
    endHalf: false,
    reason: '',
  });
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const type = types.find((t) => t.id === form.leaveTypeId);
  const ready = form.leaveTypeId && form.startDate && form.endDate;

  useEffect(() => {
    if (!ready) return undefined;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      apiFetch('/me/leave/preview', {
        method: 'POST',
        signal: ctrl.signal,
        body: {
          leaveTypeId: form.leaveTypeId,
          startDate: form.startDate,
          endDate: form.endDate,
          startHalf: form.startHalf,
          endHalf: form.endHalf,
        },
      })
        .then((p) => {
          setPreview(p);
          setPreviewError(null);
        })
        .catch((err) => {
          if (err.name === 'AbortError') return;
          setPreview(null);
          setPreviewError(err.message);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [ready, form.leaveTypeId, form.startDate, form.endDate, form.startHalf, form.endHalf]);

  const submit = useMutation({
    mutationFn: () => apiFetch('/me/leave/requests', { method: 'POST', body: form }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['me'] });
      onDone();
    },
  });
  const set = (k) => (e) =>
    setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  return (
    <Card title="Apply for leave">
      <form
        className="grid gap-3 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit.mutate();
        }}
      >
        <Field label="Leave type" htmlFor="lv-type">
          <Select id="lv-type" value={form.leaveTypeId} onChange={set('leaveTypeId')}>
            <option value="">Choose…</option>
            {types
              .filter((t) => t.status === 'active')
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="From" htmlFor="lv-from">
          <Input
            id="lv-from"
            type="date"
            value={form.startDate}
            onChange={(e) =>
              setForm({
                ...form,
                startDate: e.target.value,
                endDate: form.endDate || e.target.value,
              })
            }
          />
        </Field>
        <Field label="To" htmlFor="lv-to">
          <Input
            id="lv-to"
            type="date"
            value={form.endDate}
            min={form.startDate}
            onChange={set('endDate')}
          />
        </Field>
        <div className="flex flex-col justify-end gap-1 text-sm text-slate-700">
          {(!type || type.allowHalfDay) && (
            <>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.startHalf} onChange={set('startHalf')} /> Half
                day on first day
              </label>
              {form.endDate && form.endDate !== form.startDate && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={form.endHalf} onChange={set('endHalf')} /> Half
                  day on last day
                </label>
              )}
            </>
          )}
        </div>
        <div className="sm:col-span-4">
          <Field label="Reason" htmlFor="lv-reason">
            <Input
              id="lv-reason"
              value={form.reason}
              onChange={set('reason')}
              placeholder="e.g. Family function"
            />
          </Field>
        </div>
        <div className="sm:col-span-4 space-y-2">
          {type && (
            <p className="text-xs text-slate-500">
              {type.approvalLevels === 2
                ? 'Approved by your manager, then HR.'
                : 'Approved by your manager.'}
              {type.minNoticeDays ? ` Needs ${type.minNoticeDays} day(s) notice.` : ''}
              {type.maxConsecutiveDays ? ` Up to ${type.maxConsecutiveDays} day(s) at a time.` : ''}
            </p>
          )}
          {preview && (
            <Alert tone="green">
              {fmtDays(preview.days)} working day(s).{' '}
              {preview.balanceAfter !== null
                ? `Balance after approval: ${fmtDays(preview.balanceAfter)}.`
                : 'Unpaid leave.'}
            </Alert>
          )}
          {previewError && <Alert tone="amber">{previewError}</Alert>}
          <ErrorMessage error={submit.error} />
          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={submit.isPending || !preview || form.reason.trim().length < 3}
            >
              Send request
            </Button>
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          </div>
        </div>
      </form>
    </Card>
  );
}

export function MyLeavePage() {
  const queryClient = useQueryClient();
  const [applying, setApplying] = useState(false);
  const balances = useQuery({
    queryKey: ['me', 'leave', 'balances'],
    queryFn: () => apiFetch('/me/leave/balances'),
  });
  const types = useQuery({ queryKey: ['leave', 'types'], queryFn: () => apiFetch('/leave/types') });
  const requests = useQuery({
    queryKey: ['me', 'leave', 'requests'],
    queryFn: () => apiFetch('/me/leave/requests'),
  });
  const cancel = useMutation({
    mutationFn: (id) => apiFetch(`/me/leave/requests/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });

  return (
    <>
      <PageHeader
        title="My leave"
        description={
          balances.data
            ? `Leave year ${fmtDate(balances.data.range.start)} – ${fmtDate(balances.data.range.end)} ${balances.data.range.end.slice(0, 4)}`
            : ''
        }
        actions={!applying && <Button onClick={() => setApplying(true)}>Apply for leave</Button>}
      />
      <div className="space-y-6">
        {balances.isPending && <Spinner />}
        <ErrorMessage error={balances.error} />
        {balances.data && <BalanceCards balances={balances.data.balances} />}
        {applying && types.data && (
          <ApplyForm types={types.data.data} onDone={() => setApplying(false)} />
        )}
        <Card title="My requests">
          <ErrorMessage error={requests.error || cancel.error} />
          {requests.data?.data.length === 0 && (
            <p className="text-sm text-slate-500">No leave requests yet.</p>
          )}
          <ul className="divide-y divide-slate-100 text-sm">
            {requests.data?.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium">{r.leaveType.name}</span> · {fmtDate(r.startDate)}
                  {r.endDate !== r.startDate && ` – ${fmtDate(r.endDate)}`} · {fmtDays(r.days)}{' '}
                  day(s)
                  <span className="block text-xs text-slate-500">
                    {r.reason}
                    {r.status === 'pending' &&
                      r.approvalLevels === 2 &&
                      r.approvalLevel === 2 &&
                      ' · approved by manager, waiting for HR'}
                    {r.decisionComment && ` · Reply: ${r.decisionComment}`}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={REQUEST_TONE[r.status]}>{r.status}</Badge>
                  {['pending', 'approved'].includes(r.status) && (
                    <Button size="sm" variant="ghost" onClick={() => cancel.mutate(r.id)}>
                      Cancel
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
