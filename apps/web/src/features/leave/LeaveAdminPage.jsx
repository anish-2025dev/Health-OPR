import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDownload, apiFetch } from '@/lib/api-client';
import { useAuth } from '@/features/auth/auth-context';
import {
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
import { currentMonth, fmtDate } from '@/features/attendance/format';
import { MonthPicker } from '@/features/attendance/MonthView';
import { REQUEST_TONE } from './format';

const fmtDays = (n) =>
  n === null || n === undefined ? '∞' : Number.isInteger(n) ? String(n) : n.toFixed(1);

function Requests() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('pending');
  const [rejecting, setRejecting] = useState(null);
  const [comment, setComment] = useState('');
  const q = useQuery({
    queryKey: ['leave', 'requests', status],
    queryFn: () => apiFetch(`/leave/requests?status=${status}`),
  });
  const decide = useMutation({
    mutationFn: ({ id, action, comment: c }) =>
      apiFetch(`/leave/requests/${id}/${action}`, {
        method: 'POST',
        body: c ? { comment: c } : {},
      }),
    onSuccess: () => {
      setRejecting(null);
      setComment('');
      queryClient.invalidateQueries({ queryKey: ['leave'] });
    },
  });
  return (
    <Card
      title="Leave requests"
      actions={
        <Select
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="w-40"
        >
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="cancelled">Cancelled</option>
          <option value="all">All</option>
        </Select>
      }
    >
      {q.isPending && <Spinner />}
      <ErrorMessage error={q.error || decide.error} />
      {q.data?.data.length === 0 && <p className="text-sm text-slate-500">No requests.</p>}
      <ul className="divide-y divide-slate-100 text-sm">
        {q.data?.data.map((r) => (
          <li key={r.id} className="py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-medium text-slate-800">
                  {r.employee.fullName}{' '}
                  <span className="font-mono text-xs text-slate-500">
                    {r.employee.employeeNumber}
                  </span>
                </p>
                <p className="text-slate-600">
                  {r.leaveType.name} · {fmtDate(r.startDate)}
                  {r.endDate !== r.startDate && ` – ${fmtDate(r.endDate)}`} · {fmtDays(r.days)}{' '}
                  day(s)
                  {!r.leaveType.isPaid && <Badge tone="amber">unpaid</Badge>}
                </p>
                <p className="text-slate-500">“{r.reason}”</p>
                {r.approvalLevels === 2 && (
                  <p className="text-xs text-slate-400">
                    Two-level approval
                    {r.level1By ? ` · manager approved (${r.level1By})` : ' · waiting for manager'}
                  </p>
                )}
              </div>
              {r.canDecide ? (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => decide.mutate({ id: r.id, action: 'approve' })}>
                    {r.approvalLevels === 2 && r.approvalLevel === 1
                      ? 'Approve (level 1)'
                      : 'Approve'}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setRejecting(r.id)}>
                    Reject
                  </Button>
                </div>
              ) : (
                <Badge tone={REQUEST_TONE[r.status]}>{r.status}</Badge>
              )}
            </div>
            {rejecting === r.id && (
              <form
                className="mt-2 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  decide.mutate({ id: r.id, action: 'reject', comment });
                }}
              >
                <Input
                  aria-label="Reason for rejecting"
                  placeholder="Reason for rejecting"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="danger"
                  disabled={comment.trim().length < 3}
                >
                  Confirm reject
                </Button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Calendar() {
  const [month, setMonth] = useState(currentMonth());
  const q = useQuery({
    queryKey: ['leave', 'calendar', month],
    queryFn: () => apiFetch(`/leave/calendar?month=${month}`),
  });
  return (
    <Card title="Leave calendar" actions={<MonthPicker month={month} onChange={setMonth} />}>
      <ErrorMessage error={q.error} />
      {q.data?.data.length === 0 && (
        <p className="text-sm text-slate-500">Nobody is on leave this month.</p>
      )}
      <ul className="divide-y divide-slate-100 text-sm">
        {q.data?.data.map((r) => (
          <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2">
            <span>
              <span className="font-medium">{r.employee.fullName}</span> · {r.leaveType.name}
            </span>
            <span className="flex items-center gap-2 text-slate-600">
              {fmtDate(r.startDate)}
              {r.endDate !== r.startDate && ` – ${fmtDate(r.endDate)}`}
              <Badge tone={REQUEST_TONE[r.status]}>{r.status}</Badge>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Balances({ canManage, types }) {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['leave', 'balances'],
    queryFn: () => apiFetch('/leave/balances'),
  });
  const [adjusting, setAdjusting] = useState(null);
  const [form, setForm] = useState({ leaveTypeId: '', days: '', reason: '' });
  const [downloadError, setDownloadError] = useState(null);
  const adjust = useMutation({
    mutationFn: () =>
      apiFetch('/leave/adjustments', {
        method: 'POST',
        body: {
          employeeId: adjusting.id,
          leaveTypeId: form.leaveTypeId,
          year: q.data.year,
          days: Number(form.days),
          reason: form.reason,
        },
      }),
    onSuccess: () => {
      setAdjusting(null);
      setForm({ leaveTypeId: '', days: '', reason: '' });
      queryClient.invalidateQueries({ queryKey: ['leave'] });
    },
  });
  const carry = useMutation({
    mutationFn: () =>
      apiFetch('/leave/carry-forward', { method: 'POST', body: { fromYear: q.data.year } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['leave'] }),
  });
  const activeTypes = types.filter((t) => t.status === 'active');
  return (
    <Card
      title={q.data ? `Balances · leave year ${q.data.year}` : 'Balances'}
      actions={
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              apiDownload(
                `/leave/export?year=${q.data?.year}`,
                `approved-leave-${q.data?.year}.csv`,
              ).catch(setDownloadError)
            }
          >
            Export CSV
          </Button>
          {canManage && (
            <Button
              size="sm"
              variant="secondary"
              disabled={carry.isPending}
              onClick={() => carry.mutate()}
            >
              Carry forward to next year
            </Button>
          )}
        </div>
      }
    >
      {q.isPending && <Spinner />}
      <ErrorMessage error={q.error || adjust.error || carry.error || downloadError} />
      {carry.data && (
        <p className="mb-3 text-sm text-emerald-700">
          Carried forward: {carry.data.entries} balance(s).
        </p>
      )}
      {adjusting && (
        <form
          className="mb-4 grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            adjust.mutate();
          }}
        >
          <p className="sm:col-span-4 text-sm font-medium">Adjust balance: {adjusting.fullName}</p>
          <Field label="Leave type" htmlFor="adj-type">
            <Select
              id="adj-type"
              value={form.leaveTypeId}
              onChange={(e) => setForm({ ...form, leaveTypeId: e.target.value })}
            >
              <option value="">Choose…</option>
              {activeTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Days (+ add / − deduct)" htmlFor="adj-days">
            <Input
              id="adj-days"
              type="number"
              step="0.5"
              value={form.days}
              onChange={(e) => setForm({ ...form, days: e.target.value })}
            />
          </Field>
          <Field label="Reason" htmlFor="adj-reason">
            <Input
              id="adj-reason"
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </Field>
          <div className="flex items-end gap-2">
            <Button
              type="submit"
              disabled={!form.leaveTypeId || !Number(form.days) || form.reason.trim().length < 3}
            >
              Save
            </Button>
            <Button variant="ghost" onClick={() => setAdjusting(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {q.data && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 pr-3">Employee</th>
                {activeTypes.map((t) => (
                  <th key={t.id} className="py-2 pr-3">
                    {t.code}
                  </th>
                ))}
                {canManage && <th />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {q.data.data.map(({ employee, balances }) => (
                <tr key={employee.id}>
                  <td className="py-1.5 pr-3">
                    {employee.fullName}{' '}
                    <span className="font-mono text-xs text-slate-500">
                      {employee.employeeNumber}
                    </span>
                  </td>
                  {activeTypes.map((t) => {
                    const b = balances.find((x) => x.type.id === t.id);
                    return (
                      <td
                        key={t.id}
                        className="py-1.5 pr-3"
                        title={b ? `used ${b.used}, pending ${b.pending}` : ''}
                      >
                        {b ? fmtDays(b.available) : '—'}
                      </td>
                    );
                  })}
                  {canManage && (
                    <td className="py-1.5 text-right">
                      <Button size="sm" variant="ghost" onClick={() => setAdjusting(employee)}>
                        Adjust
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const EMPTY_TYPE = {
  name: '',
  code: '',
  isPaid: true,
  annualQuota: '12',
  accrual: 'yearly_upfront',
  carryForwardMax: '0',
  allowHalfDay: true,
  minNoticeDays: '0',
  maxConsecutiveDays: '',
  approvalLevels: '1',
};

function Types({ types, canManage }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(null);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name,
        code: form.code,
        isPaid: form.isPaid,
        annualQuota: Number(form.annualQuota),
        accrual: form.accrual,
        carryForwardMax: Number(form.carryForwardMax),
        allowHalfDay: form.allowHalfDay,
        minNoticeDays: Number(form.minNoticeDays),
        maxConsecutiveDays: form.maxConsecutiveDays ? Number(form.maxConsecutiveDays) : null,
        approvalLevels: Number(form.approvalLevels),
      };
      return form.id
        ? apiFetch(`/leave/types/${form.id}`, { method: 'PATCH', body })
        : apiFetch('/leave/types', { method: 'POST', body });
    },
    onSuccess: () => {
      setForm(null);
      queryClient.invalidateQueries({ queryKey: ['leave'] });
    },
  });
  const toggle = useMutation({
    mutationFn: (t) =>
      apiFetch(`/leave/types/${t.id}`, {
        method: 'PATCH',
        body: { status: t.status === 'active' ? 'inactive' : 'active' },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['leave'] }),
  });
  const set = (k) => (e) =>
    setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  return (
    <Card
      title="Leave types"
      actions={
        canManage &&
        !form && (
          <Button size="sm" onClick={() => setForm(EMPTY_TYPE)}>
            Add leave type
          </Button>
        )
      }
    >
      <ErrorMessage error={save.error || toggle.error} />
      {form && (
        <form
          className="mb-4 grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Name" htmlFor="lt-name">
            <Input
              id="lt-name"
              value={form.name}
              onChange={set('name')}
              placeholder="Casual Leave"
            />
          </Field>
          <Field label="Code" htmlFor="lt-code">
            <Input
              id="lt-code"
              value={form.code}
              onChange={set('code')}
              placeholder="CL"
              className="uppercase"
            />
          </Field>
          <Field label="Days per year" htmlFor="lt-quota">
            <Input
              id="lt-quota"
              type="number"
              step="0.5"
              min="0"
              value={form.annualQuota}
              onChange={set('annualQuota')}
            />
          </Field>
          <Field label="Credited" htmlFor="lt-accrual">
            <Select id="lt-accrual" value={form.accrual} onChange={set('accrual')}>
              <option value="yearly_upfront">All at start of year</option>
              <option value="monthly">Monthly (1/12 each month)</option>
              <option value="none">Not credited (e.g. unpaid)</option>
            </Select>
          </Field>
          <Field label="Carry forward up to (days)" htmlFor="lt-cf">
            <Input
              id="lt-cf"
              type="number"
              step="0.5"
              min="0"
              value={form.carryForwardMax}
              onChange={set('carryForwardMax')}
            />
          </Field>
          <Field label="Minimum notice (days)" htmlFor="lt-notice">
            <Input
              id="lt-notice"
              type="number"
              min="0"
              value={form.minNoticeDays}
              onChange={set('minNoticeDays')}
            />
          </Field>
          <Field label="Max days at a time" htmlFor="lt-max" hint="Empty = no limit">
            <Input
              id="lt-max"
              type="number"
              min="1"
              value={form.maxConsecutiveDays ?? ''}
              onChange={set('maxConsecutiveDays')}
            />
          </Field>
          <Field label="Approval" htmlFor="lt-levels">
            <Select
              id="lt-levels"
              value={String(form.approvalLevels)}
              onChange={set('approvalLevels')}
            >
              <option value="1">Manager</option>
              <option value="2">Manager, then HR</option>
            </Select>
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.isPaid} onChange={set('isPaid')} /> Paid leave
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.allowHalfDay} onChange={set('allowHalfDay')} />{' '}
            Half days allowed
          </label>
          <div className="flex items-end gap-2 sm:col-span-2">
            <Button
              type="submit"
              disabled={save.isPending || form.name.trim().length < 2 || !form.code.trim()}
            >
              Save
            </Button>
            <Button variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <ul className="divide-y divide-slate-100 text-sm">
        {types.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              <span className={`font-medium ${t.status === 'active' ? '' : 'text-slate-400'}`}>
                {t.name} ({t.code})
              </span>
              <span className="block text-xs text-slate-500">
                {t.isPaid ? 'Paid' : 'Unpaid'} · {t.annualQuota} days/year ·{' '}
                {t.accrual === 'monthly'
                  ? 'monthly'
                  : t.accrual === 'none'
                    ? 'not credited'
                    : 'credited yearly'}
                {t.carryForwardMax ? ` · carry forward ${t.carryForwardMax}` : ''}
                {t.minNoticeDays ? ` · ${t.minNoticeDays}d notice` : ''}
                {t.maxConsecutiveDays ? ` · max ${t.maxConsecutiveDays}d` : ''} ·{' '}
                {t.approvalLevels === 2 ? 'manager + HR' : 'manager'}
              </span>
            </span>
            {canManage && (
              <span className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setForm({
                      ...t,
                      annualQuota: String(t.annualQuota),
                      carryForwardMax: String(t.carryForwardMax),
                      minNoticeDays: String(t.minNoticeDays),
                      maxConsecutiveDays: t.maxConsecutiveDays ? String(t.maxConsecutiveDays) : '',
                      approvalLevels: String(t.approvalLevels),
                    })
                  }
                >
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => toggle.mutate(t)}>
                  {t.status === 'active' ? 'Deactivate' : 'Activate'}
                </Button>
              </span>
            )}
          </li>
        ))}
        {types.length === 0 && (
          <li className="py-2 text-slate-500">
            No leave types yet. Add Casual, Sick, Earned and Loss of Pay leave to start.
          </li>
        )}
      </ul>
    </Card>
  );
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function Settings() {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['leave', 'settings'],
    queryFn: () => apiFetch('/leave/settings'),
  });
  const save = useMutation({
    mutationFn: (m) =>
      apiFetch('/leave/settings', { method: 'PUT', body: { leaveYearStartMonth: m } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['leave'] }),
  });
  if (!q.data) return null;
  return (
    <Card title="Leave year">
      <Field
        label="Leave year starts in"
        htmlFor="ly-start"
        hint="Can only be changed before any leave is requested"
      >
        <Select
          id="ly-start"
          className="w-48"
          value={q.data.leaveYearStartMonth}
          onChange={(e) => save.mutate(Number(e.target.value))}
        >
          {MONTHS.map((m, i) => (
            <option key={m} value={i + 1}>
              {m}
            </option>
          ))}
        </Select>
      </Field>
      <div className="mt-2">
        <ErrorMessage error={save.error} />
      </div>
    </Card>
  );
}

export function LeaveAdminPage() {
  const auth = useAuth();
  const canRead = auth.can('leave.read');
  const canManage = auth.can('leave.manage');
  const types = useQuery({ queryKey: ['leave', 'types'], queryFn: () => apiFetch('/leave/types') });
  return (
    <>
      <PageHeader title="Leave" description="Approvals, balances and leave rules." />
      <div className="space-y-6">
        <Requests />
        <Calendar />
        {canRead && types.data && <Balances canManage={canManage} types={types.data.data} />}
        {canRead && types.data && <Types types={types.data.data} canManage={canManage} />}
        {canManage && <Settings />}
      </div>
    </>
  );
}
