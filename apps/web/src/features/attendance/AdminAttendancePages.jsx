import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { apiDownload, apiFetch } from '@/lib/api-client';
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
import { MonthPicker, MonthView, StatusBadge, StatusSelect } from './MonthView';
import { currentMonth, fmtDate, fmtDuration } from './format';

const localToday = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

function KpiCard({ label, value, tone }) {
  const tones = {
    slate: 'border-slate-200 text-slate-900',
    green: 'border-emerald-200 text-emerald-700',
    red: 'border-rose-200 text-rose-700',
    amber: 'border-amber-200 text-amber-700',
    brand: 'border-brand-600/30 text-brand-700',
  };
  return (
    <div className={`rounded-xl border bg-white px-4 py-3 shadow-sm ${tones[tone]}`}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}

function AttendanceNav() {
  const auth = useAuth();
  const links = [
    { to: '/attendance', label: 'Dashboard', show: auth.can('attendance.read') },
    { to: '/attendance/register', label: 'Daily register', show: auth.can('attendance.read') },
    {
      to: '/attendance/requests',
      label: 'Correction requests',
      show: auth.can('attendance.manage') || auth.me.employee?.isManager,
    },
    { to: '/attendance/team', label: 'My team', show: auth.me.employee?.isManager },
    { to: '/attendance/settings', label: 'Rules', show: auth.can('attendance.read') },
  ].filter((l) => l.show);
  return (
    <nav aria-label="Attendance sections" className="mb-6 flex flex-wrap gap-2">
      {links.map((l) => (
        <Link
          key={l.to}
          to={l.to}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

function ExportButton() {
  const [month, setMonth] = useState(currentMonth());
  const [error, setError] = useState(null);
  return (
    <div className="flex items-center gap-2">
      <Input
        type="month"
        aria-label="Export month"
        value={month}
        onChange={(e) => setMonth(e.target.value)}
        className="w-40"
      />
      <Button
        variant="secondary"
        onClick={() => {
          setError(null);
          apiDownload(`/attendance/export?month=${month}`, `attendance-${month}.csv`).catch(
            setError,
          );
        }}
      >
        Export CSV
      </Button>
      {error && <span className="text-xs text-rose-600">{error.message}</span>}
    </div>
  );
}

// ------------------------------------------------------------------ dashboard

export function AttendanceDashboardPage() {
  const [date, setDate] = useState(localToday());
  const q = useQuery({
    queryKey: ['attendance', 'dashboard', date],
    queryFn: () => apiFetch(`/attendance/dashboard?date=${date}`),
  });
  const t = q.data?.totals;
  return (
    <>
      <PageHeader
        title="Attendance"
        description="Live summary of the workforce."
        actions={
          <Input
            type="date"
            aria-label="Date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-44"
          />
        }
      />
      <AttendanceNav />
      {q.isPending && <Spinner />}
      <ErrorMessage error={q.error} />
      {t && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <KpiCard label="Employees" value={t.employees} tone="slate" />
            <KpiCard label="Checked in" value={t.checkedIn} tone="green" />
            <KpiCard label="Late" value={t.late} tone="amber" />
            <KpiCard label="Absent / not in" value={t.absent + t.notCheckedIn} tone="red" />
            <KpiCard label="Week off" value={t.weekOff} tone="slate" />
            <KpiCard label="Holiday / leave" value={t.holiday + t.leave} tone="brand" />
          </div>
          <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
            <Card title="Late arrivals">
              {q.data.lateToday.length === 0 ? (
                <p className="text-sm text-slate-500">No late arrivals.</p>
              ) : (
                <table className="min-w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="py-2 pr-3">Employee</th>
                      <th className="py-2 pr-3">Department</th>
                      <th className="py-2 pr-3">In</th>
                      <th className="py-2 pr-3">Late by</th>
                      <th className="py-2 pr-3">Manager</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {q.data.lateToday.map((l) => (
                      <tr key={l.employee.id}>
                        <td className="py-1.5 pr-3">
                          <Link
                            to={`/attendance/employees/${l.employee.id}`}
                            className="text-brand-700 hover:underline"
                          >
                            {l.employee.fullName}
                          </Link>
                        </td>
                        <td className="py-1.5 pr-3">{l.employee.department?.name ?? '—'}</td>
                        <td className="py-1.5 pr-3 font-mono text-xs">{l.checkIn}</td>
                        <td className="py-1.5 pr-3">
                          <Badge tone={l.category === 'Very late' ? 'red' : 'amber'}>
                            {l.lateMinutes} min · {l.category}
                          </Badge>
                        </td>
                        <td className="py-1.5 pr-3 text-slate-600">
                          {l.employee.managerName ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <div className="space-y-6">
              <Card title="By department">
                <ul className="space-y-2 text-sm">
                  {q.data.byDepartment.map((d) => (
                    <li key={d.department}>
                      <div className="flex justify-between">
                        <span>{d.department}</span>
                        <span className="text-slate-500">
                          {d.checkedIn}/{d.total}
                        </span>
                      </div>
                      <div className="mt-1 h-2 rounded-full bg-slate-100">
                        <div
                          className="h-2 rounded-full bg-emerald-500"
                          style={{ width: `${d.total ? (d.checkedIn / d.total) * 100 : 0}%` }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card title="Holidays this month">
                {q.data.holidays.length === 0 ? (
                  <p className="text-sm text-slate-500">None.</p>
                ) : (
                  <ul className="text-sm">
                    {q.data.holidays.map((h) => (
                      <li key={`${h.date}-${h.name}`} className="flex justify-between py-1">
                        <span>{h.name}</span>
                        <span className="text-slate-500">{fmtDate(h.date)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
          <Card title="Export">
            <ExportButton />
          </Card>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ register + manual edit

function EditDayForm({ employee, day, onDone }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    status: '',
    checkIn: day.checkIn ?? '',
    checkOut: day.checkOut ?? '',
    reason: '',
  });
  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/attendance/employees/${employee.id}/days/${day.date}`, {
        method: 'PUT',
        body: {
          ...(form.status ? { status: form.status } : {}),
          ...(form.checkIn && form.checkIn !== day.checkIn ? { checkIn: form.checkIn } : {}),
          ...(form.checkOut && form.checkOut !== day.checkOut ? { checkOut: form.checkOut } : {}),
          reason: form.reason,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attendance'] });
      onDone();
    },
  });
  return (
    <Card title={`Edit attendance: ${employee.fullName}, ${fmtDate(day.date)}`} className="mb-6">
      <form
        className="grid gap-3 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Status" htmlFor="ed-status">
          <StatusSelect
            id="ed-status"
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
          />
        </Field>
        <Field label="Check-in" htmlFor="ed-in">
          <Input
            id="ed-in"
            type="time"
            value={form.checkIn}
            onChange={(e) => setForm({ ...form, checkIn: e.target.value })}
          />
        </Field>
        <Field label="Check-out" htmlFor="ed-out">
          <Input
            id="ed-out"
            type="time"
            value={form.checkOut}
            onChange={(e) => setForm({ ...form, checkOut: e.target.value })}
          />
        </Field>
        <Field label="Reason (required)" htmlFor="ed-reason" hint="Recorded in the audit log">
          <Input
            id="ed-reason"
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
          />
        </Field>
        <div className="flex gap-2 sm:col-span-4">
          <Button type="submit" disabled={save.isPending || form.reason.trim().length < 5}>
            Save
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
        <div className="sm:col-span-4">
          <ErrorMessage error={save.error} />
        </div>
      </form>
    </Card>
  );
}

export function AttendanceRegisterPage() {
  const auth = useAuth();
  const canEdit = auth.can('attendance.manage');
  const [date, setDate] = useState(localToday());
  const [departmentId, setDepartmentId] = useState('');
  const [editing, setEditing] = useState(null);
  const departments = useQuery({
    queryKey: ['departments'],
    queryFn: () => apiFetch('/departments'),
  });
  const params = new URLSearchParams({ date });
  if (departmentId) params.set('departmentId', departmentId);
  const q = useQuery({
    queryKey: ['attendance', 'register', params.toString()],
    queryFn: () => apiFetch(`/attendance/register?${params}`),
  });

  return (
    <>
      <PageHeader
        title="Daily register"
        description="Every employee's attendance for one day."
        actions={
          <div className="flex gap-2">
            <Input
              type="date"
              aria-label="Date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-44"
            />
            <Select
              aria-label="Department"
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              className="w-48"
            >
              <option value="">All departments</option>
              {departments.data?.data.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </div>
        }
      />
      <AttendanceNav />
      {editing && <EditDayForm {...editing} onDone={() => setEditing(null)} />}
      <Card>
        {q.isPending && <Spinner />}
        <ErrorMessage error={q.error} />
        {q.data && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-3">Employee</th>
                  <th className="py-2 pr-3">Department</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">In</th>
                  <th className="py-2 pr-3">Out</th>
                  <th className="py-2 pr-3">Hours</th>
                  <th className="py-2 pr-3">Late</th>
                  <th className="py-2 pr-3">OT</th>
                  {canEdit && <th className="py-2" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {q.data.data.map(({ employee, day }) => (
                  <tr key={employee.id}>
                    <td className="py-1.5 pr-3">
                      <Link
                        to={`/attendance/employees/${employee.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {employee.fullName}
                      </Link>
                      <p className="font-mono text-xs text-slate-500">{employee.employeeNumber}</p>
                    </td>
                    <td className="py-1.5 pr-3">{employee.department?.name ?? '—'}</td>
                    <td className="py-1.5 pr-3">
                      <StatusBadge status={day.status} />
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-xs">{day.checkIn ?? '—'}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs">{day.checkOut ?? '—'}</td>
                    <td className="py-1.5 pr-3">{fmtDuration(day.workedMinutes)}</td>
                    <td className="py-1.5 pr-3">
                      {day.isLate ? (
                        <span className="text-amber-700">{day.lateMinutes}m</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-1.5 pr-3">{fmtDuration(day.overtimeMinutes)}</td>
                    {canEdit && (
                      <td className="py-1.5 text-right">
                        {day.status !== 'upcoming' && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setEditing({ employee, day })}
                          >
                            Edit
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
                {q.data.data.length === 0 && (
                  <tr>
                    <td colSpan={9} className="py-6 text-center text-slate-500">
                      No employees for this filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ employee month

export function EmployeeAttendancePage() {
  const { id } = useParams();
  const [month, setMonth] = useState(currentMonth());
  const [editing, setEditing] = useState(null);
  const q = useQuery({
    queryKey: ['attendance', 'employee', id, month],
    queryFn: () => apiFetch(`/attendance/employees/${id}/month?month=${month}`),
  });
  return (
    <>
      <PageHeader
        title={q.data ? q.data.employee.fullName : 'Employee attendance'}
        description={
          q.data
            ? `${q.data.employee.employeeNumber} · ${q.data.employee.branch.name}${q.data.employee.shift ? ` · ${q.data.employee.shift.name} ${q.data.employee.shift.start}–${q.data.employee.shift.end}` : ''}`
            : ''
        }
        actions={<MonthPicker month={month} onChange={setMonth} />}
      />
      {editing && q.data && (
        <EditDayForm employee={q.data.employee} day={editing} onDone={() => setEditing(null)} />
      )}
      {q.isPending && <Spinner />}
      <ErrorMessage error={q.error} />
      {q.data && (
        <MonthView
          data={q.data}
          dayActionLabel="Edit"
          onDayAction={q.data.canEdit ? setEditing : undefined}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------ correction requests

const TABS = ['pending', 'approved', 'rejected', 'all'];

export function RegularizationsPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('pending');
  const [search, setSearch] = useState('');
  const [rejecting, setRejecting] = useState(null);
  const [comment, setComment] = useState('');
  const q = useQuery({
    queryKey: ['attendance', 'regularizations', tab],
    queryFn: () => apiFetch(`/attendance/regularizations?status=${tab}`),
  });
  const decide = useMutation({
    mutationFn: ({ id, approve, comment: c }) =>
      apiFetch(`/attendance/regularizations/${id}/${approve ? 'approve' : 'reject'}`, {
        method: 'POST',
        body: c ? { comment: c } : {},
      }),
    onSuccess: () => {
      setRejecting(null);
      setComment('');
      queryClient.invalidateQueries({ queryKey: ['attendance'] });
    },
  });
  const term = search.trim().toLowerCase();
  const rows = (q.data?.data ?? []).filter(
    (r) =>
      !term ||
      r.employee.fullName.toLowerCase().includes(term) ||
      r.employee.employeeNumber.toLowerCase().includes(term),
  );
  const counts = q.data?.counts ?? {};

  return (
    <>
      <PageHeader
        title="Correction requests"
        description="Attendance corrections requested by employees."
      />
      <AttendanceNav />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1" role="tablist">
          {TABS.map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={tab === s}
              onClick={() => setTab(s)}
              className={`rounded-lg px-3 py-1.5 text-sm capitalize ${tab === s ? 'bg-brand-700 text-white' : 'bg-white text-slate-700 border border-slate-200'}`}
            >
              {s}
              {s !== 'all' && counts[s] ? ` (${counts[s]})` : ''}
            </button>
          ))}
        </div>
        <Input
          aria-label="Search requests"
          placeholder="Search employee or ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64"
        />
      </div>
      <ErrorMessage error={q.error || decide.error} />
      <Card>
        {q.isPending && <Spinner />}
        {rows.length === 0 && !q.isPending && (
          <p className="text-sm text-slate-500">No requests.</p>
        )}
        <ul className="divide-y divide-slate-100">
          {rows.map((r) => (
            <li key={r.id} className="py-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-slate-800">
                    {r.employee.fullName}{' '}
                    <span className="font-mono text-xs text-slate-500">
                      {r.employee.employeeNumber}
                    </span>
                  </p>
                  <p className="text-slate-600">
                    {fmtDate(r.date)} ·{' '}
                    {[
                      r.checkIn && `in ${r.checkIn}`,
                      r.checkOut && `out ${r.checkOut}`,
                      r.status && `status ${r.status}`,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </p>
                  <p className="text-slate-500">“{r.reason}”</p>
                  {r.decidedBy && (
                    <p className="text-xs text-slate-400">
                      {r.state} by {r.decidedBy}
                      {r.decisionComment ? `: ${r.decisionComment}` : ''}
                    </p>
                  )}
                </div>
                {r.state === 'pending' ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => decide.mutate({ id: r.id, approve: true })}
                      disabled={decide.isPending}
                    >
                      Approve
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setRejecting(r.id)}>
                      Reject
                    </Button>
                  </div>
                ) : (
                  <Badge
                    tone={
                      r.state === 'approved' ? 'green' : r.state === 'rejected' ? 'red' : 'slate'
                    }
                  >
                    {r.state}
                  </Badge>
                )}
              </div>
              {rejecting === r.id && (
                <form
                  className="mt-2 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    decide.mutate({ id: r.id, approve: false, comment });
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
    </>
  );
}

// ------------------------------------------------------------------ team

export function TeamAttendancePage() {
  const [month, setMonth] = useState(currentMonth());
  const q = useQuery({
    queryKey: ['attendance', 'team', month],
    queryFn: () => apiFetch(`/attendance/team?month=${month}`),
  });
  return (
    <>
      <PageHeader
        title="My team"
        description="Attendance of people who report to you."
        actions={<MonthPicker month={month} onChange={setMonth} />}
      />
      <AttendanceNav />
      <Card>
        {q.isPending && <Spinner />}
        <ErrorMessage error={q.error} />
        {q.data && (
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 pr-3">Employee</th>
                <th className="py-2 pr-3">Present</th>
                <th className="py-2 pr-3">Half days</th>
                <th className="py-2 pr-3">Absent</th>
                <th className="py-2 pr-3">Late</th>
                <th className="py-2 pr-3">Overtime</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {q.data.data.map(({ employee, summary }) => (
                <tr key={employee.id}>
                  <td className="py-1.5 pr-3">
                    <Link
                      to={`/attendance/employees/${employee.id}`}
                      className="text-brand-700 hover:underline"
                    >
                      {employee.fullName}
                    </Link>
                  </td>
                  <td className="py-1.5 pr-3">{summary.present}</td>
                  <td className="py-1.5 pr-3">{summary.halfDay}</td>
                  <td className="py-1.5 pr-3">{summary.absent + summary.incomplete}</td>
                  <td className="py-1.5 pr-3">{summary.late}</td>
                  <td className="py-1.5 pr-3">{fmtDuration(summary.overtimeMinutes)}</td>
                </tr>
              ))}
              {q.data.data.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-500">
                    Nobody reports to you.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ rules

const toForm = (p) => ({
  fullDayHours: String(p.fullDayMinutes / 60),
  halfDayHours: String(p.halfDayMinutes / 60),
  belowHalfDayStatus: p.belowHalfDayStatus,
  lateGraceMinutes: String(p.lateGraceMinutes),
  lateFreePerMonth: String(p.lateFreePerMonth),
  latePenaltyMode: p.latePenaltyMode,
  latePenaltyAmount: p.latePenaltyAmount ?? '',
  latePenaltyEveryN: p.latePenaltyEveryN ? String(p.latePenaltyEveryN) : '',
  overtimeAfterMinutes: String(p.overtimeAfterMinutes),
  minPunchGapSeconds: String(p.minPunchGapSeconds),
});

function PolicyForm({ policy, canEdit }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => toForm(policy));
  const [saved, setSaved] = useState(false);
  const set = (k) => (e) => {
    setSaved(false);
    setForm({ ...form, [k]: e.target.value });
  };
  const save = useMutation({
    mutationFn: () =>
      apiFetch('/attendance/policy', {
        method: 'PUT',
        body: {
          fullDayMinutes: Math.round(Number(form.fullDayHours) * 60),
          halfDayMinutes: Math.round(Number(form.halfDayHours) * 60),
          belowHalfDayStatus: form.belowHalfDayStatus,
          lateGraceMinutes: Number(form.lateGraceMinutes),
          lateFreePerMonth: Number(form.lateFreePerMonth),
          latePenaltyMode: form.latePenaltyMode,
          latePenaltyAmount:
            form.latePenaltyMode === 'fixed_amount' ? form.latePenaltyAmount : null,
          latePenaltyEveryN: ['half_day_per_n', 'full_day_per_n'].includes(form.latePenaltyMode)
            ? Number(form.latePenaltyEveryN)
            : null,
          overtimeAfterMinutes: Number(form.overtimeAfterMinutes),
          minPunchGapSeconds: Number(form.minPunchGapSeconds),
        },
      }),
    onSuccess: () => {
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ['attendance'] });
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <fieldset disabled={!canEdit} className="space-y-6">
        <Card title="Working hours">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Full day (hours)" htmlFor="p-full" hint="From check-in to check-out">
              <Input
                id="p-full"
                type="number"
                step="0.5"
                min="1"
                max="24"
                value={form.fullDayHours}
                onChange={set('fullDayHours')}
              />
            </Field>
            <Field label="Half day (hours)" htmlFor="p-half">
              <Input
                id="p-half"
                type="number"
                step="0.5"
                min="0.5"
                max="24"
                value={form.halfDayHours}
                onChange={set('halfDayHours')}
              />
            </Field>
            <Field label="Below half day counts as" htmlFor="p-below">
              <Select
                id="p-below"
                value={form.belowHalfDayStatus}
                onChange={set('belowHalfDayStatus')}
              >
                <option value="absent">Absent</option>
                <option value="reduced_hours">Reduced hours</option>
              </Select>
            </Field>
            <Field label="Overtime after (minutes beyond full day)" htmlFor="p-ot">
              <Input
                id="p-ot"
                type="number"
                min="0"
                max="600"
                value={form.overtimeAfterMinutes}
                onChange={set('overtimeAfterMinutes')}
              />
            </Field>
            <Field label="Minimum gap between punches (seconds)" htmlFor="p-gap">
              <Input
                id="p-gap"
                type="number"
                min="0"
                max="3600"
                value={form.minPunchGapSeconds}
                onChange={set('minPunchGapSeconds')}
              />
            </Field>
          </div>
        </Card>
        <Card title="Late arrivals">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Grace period (minutes)" htmlFor="p-grace">
              <Input
                id="p-grace"
                type="number"
                min="0"
                max="240"
                value={form.lateGraceMinutes}
                onChange={set('lateGraceMinutes')}
              />
            </Field>
            <Field label="Free late arrivals per month" htmlFor="p-free">
              <Input
                id="p-free"
                type="number"
                min="0"
                max="31"
                value={form.lateFreePerMonth}
                onChange={set('lateFreePerMonth')}
              />
            </Field>
            <Field label="Penalty after the free count" htmlFor="p-mode">
              <Select id="p-mode" value={form.latePenaltyMode} onChange={set('latePenaltyMode')}>
                <option value="none">No penalty (track only)</option>
                <option value="fixed_amount">Fixed amount per late arrival</option>
                <option value="half_day_per_n">Half-day deduction every N late arrivals</option>
                <option value="full_day_per_n">Full-day deduction every N late arrivals</option>
              </Select>
            </Field>
            {form.latePenaltyMode === 'fixed_amount' && (
              <Field label="Amount per late arrival (₹)" htmlFor="p-amount">
                <Input
                  id="p-amount"
                  inputMode="decimal"
                  value={form.latePenaltyAmount}
                  onChange={set('latePenaltyAmount')}
                />
              </Field>
            )}
            {['half_day_per_n', 'full_day_per_n'].includes(form.latePenaltyMode) && (
              <Field label="Every N late arrivals" htmlFor="p-n">
                <Input
                  id="p-n"
                  type="number"
                  min="1"
                  max="31"
                  value={form.latePenaltyEveryN}
                  onChange={set('latePenaltyEveryN')}
                />
              </Field>
            )}
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Penalties are shown on attendance now and will be applied as deductions when payroll is
            added.
          </p>
        </Card>
      </fieldset>
      <div className="mt-6 space-y-3">
        <ErrorMessage error={save.error} />
        {saved && (
          <Alert tone="green">Rules saved. They apply to attendance recorded from now on.</Alert>
        )}
        {canEdit && (
          <Button type="submit" disabled={save.isPending}>
            Save rules
          </Button>
        )}
      </div>
    </form>
  );
}

export function AttendanceSettingsPage() {
  const auth = useAuth();
  const q = useQuery({
    queryKey: ['attendance', 'policy'],
    queryFn: () => apiFetch('/attendance/policy'),
  });
  return (
    <>
      <PageHeader
        title="Attendance rules"
        description="How check-in and check-out times turn into present, half day, late and overtime."
      />
      <AttendanceNav />
      {q.isPending && <Spinner />}
      <ErrorMessage error={q.error} />
      {q.data && <PolicyForm policy={q.data} canEdit={auth.can('attendance.manage')} />}
    </>
  );
}
