import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
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
import { currentMonth } from '@/features/attendance/format';
import { METRIC_LABELS, PAY_TONE, RATE_LABELS, RUN_TONE, inr } from './format';

function PayrollNav() {
  const auth = useAuth();
  const links = [
    { to: '/payroll', label: 'Payroll runs' },
    { to: '/payroll/salaries', label: 'Salaries' },
    { to: '/payroll/statutory', label: 'Statutory', show: true },
    { to: '/payroll/setup', label: 'Setup', show: true },
  ];
  return (
    <nav aria-label="Payroll sections" className="mb-6 flex flex-wrap gap-2">
      {links
        .filter((l) => l.show !== false && auth.can('payroll.read'))
        .map((l) => (
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

const download = (path, name, setError) => apiDownload(path, name).catch(setError);

// ================================================================== runs list

export function PayrollRunsPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const canManage = auth.can('payroll.manage');
  const [month, setMonth] = useState(currentMonth());
  const runs = useQuery({
    queryKey: ['payroll', 'runs'],
    queryFn: () => apiFetch('/payroll/runs'),
  });
  const create = useMutation({
    mutationFn: () => apiFetch('/payroll/runs', { method: 'POST', body: { month } }),
    onSuccess: (run) => navigate(`/payroll/runs/${run.id}`),
  });
  return (
    <>
      <PageHeader
        title="Payroll"
        description="Monthly payroll from attendance, leave and salary structures."
      />
      <PayrollNav />
      {canManage && (
        <Card title="Start a payroll run" className="mb-6">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Month" htmlFor="run-month">
              <Input
                id="run-month"
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                className="w-48"
              />
            </Field>
            <Button type="submit" disabled={create.isPending}>
              Create run
            </Button>
          </form>
          <div className="mt-3">
            <ErrorMessage error={create.error} />
          </div>
        </Card>
      )}
      <Card title="Payroll runs">
        {runs.isPending && <Spinner />}
        <ErrorMessage error={runs.error} />
        {runs.data?.data.length === 0 && (
          <p className="text-sm text-slate-500">No payroll runs yet.</p>
        )}
        <ul className="divide-y divide-slate-100 text-sm">
          {runs.data?.data.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <Link
                to={`/payroll/runs/${r.id}`}
                className="font-medium text-brand-700 hover:underline"
              >
                {r.period.label}
                {r.branchName ? ` · ${r.branchName}` : ''}
              </Link>
              <span className="flex items-center gap-3 text-slate-600">
                {r.totals.employees} employees · net {inr(r.totals.net)}
                <Badge tone={RUN_TONE[r.status]}>{r.status}</Badge>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

// ================================================================== run detail

function ItemLines({ item }) {
  const earnings = item.lines.filter((l) => l.kind === 'earning');
  const deductions = item.lines.filter((l) => l.kind === 'deduction');
  const employer = item.lines.filter((l) => l.kind === 'employer');
  const table = (title, lines) => (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase text-slate-500">{title}</p>
      <ul className="text-sm">
        {lines.map((l, i) => (
          <li key={`${l.code}-${i}`} className="flex justify-between gap-3 py-0.5">
            <span>
              {l.label}
              {l.detail && <span className="block text-xs text-slate-400">{l.detail}</span>}
            </span>
            <span className="font-mono">{inr(l.amount)}</span>
          </li>
        ))}
        {lines.length === 0 && <li className="text-slate-400">None</li>}
      </ul>
    </div>
  );
  return (
    <div className="grid gap-4 rounded-lg bg-slate-50 p-4 sm:grid-cols-3">
      {table('Earnings', earnings)}
      <div className="space-y-3">
        {table('Deductions', deductions)}
        {employer.length > 0 && table('Employer contributions (not deducted)', employer)}
      </div>
      <div className="text-sm text-slate-600">
        <p className="mb-1 text-xs font-semibold uppercase text-slate-500">Attendance used</p>
        <p>Loss of pay: {item.metrics.lopDays} day(s)</p>
        <p>
          Paid leave: {item.metrics.paidLeaveDays} · unpaid leave: {item.metrics.unpaidLeaveDays}
        </p>
        <p>
          Absent: {item.metrics.absentDays} · half days: {item.metrics.halfDays}
        </p>
        <p>Late arrivals: {item.metrics.lateCount}</p>
        <p>Day rate: {inr(item.dayRate)}</p>
      </div>
    </div>
  );
}

function AdjustmentForm({ run, onDone }) {
  const queryClient = useQueryClient();
  const employees = useQuery({
    queryKey: ['employees', 'payroll-adj'],
    queryFn: () => apiFetch('/hr/employees?status=all&limit=200'),
  });
  const [form, setForm] = useState({
    employeeId: '',
    kind: 'earning',
    label: '',
    amount: '',
    reason: '',
  });
  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/payroll/runs/${run.id}/adjustments`, { method: 'POST', body: form }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payroll'] });
      onDone();
    },
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <Card title="Add adjustment" className="mb-6">
      <form
        className="grid gap-3 sm:grid-cols-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Employee" htmlFor="adj-emp">
          <Select id="adj-emp" value={form.employeeId} onChange={set('employeeId')}>
            <option value="">Choose…</option>
            {employees.data?.data.map((e) => (
              <option key={e.id} value={e.id}>
                {e.fullName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Type" htmlFor="adj-kind">
          <Select id="adj-kind" value={form.kind} onChange={set('kind')}>
            <option value="earning">Earning (add)</option>
            <option value="deduction">Deduction (subtract)</option>
          </Select>
        </Field>
        <Field label="Label on payslip" htmlFor="adj-label">
          <Input
            id="adj-label"
            value={form.label}
            onChange={set('label')}
            placeholder="Festival bonus"
          />
        </Field>
        <Field label="Amount (₹)" htmlFor="adj-amount">
          <Input id="adj-amount" inputMode="decimal" value={form.amount} onChange={set('amount')} />
        </Field>
        <Field label="Reason (audit)" htmlFor="adj-reason">
          <Input id="adj-reason" value={form.reason} onChange={set('reason')} />
        </Field>
        <div className="flex gap-2 sm:col-span-5">
          <Button
            type="submit"
            disabled={
              save.isPending ||
              !form.employeeId ||
              !form.label ||
              !form.amount ||
              form.reason.length < 3
            }
          >
            Add
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
        <div className="sm:col-span-5">
          <ErrorMessage error={save.error} />
        </div>
      </form>
    </Card>
  );
}

export function PayrollRunPage() {
  const { id } = useParams();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [selected, setSelected] = useState([]);
  const [reference, setReference] = useState('');
  const [error, setError] = useState(null);
  const q = useQuery({
    queryKey: ['payroll', 'run', id],
    queryFn: () => apiFetch(`/payroll/runs/${id}`),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['payroll'] });
  const calculate = useMutation({
    mutationFn: () => apiFetch(`/payroll/runs/${id}/calculate`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const approve = useMutation({
    mutationFn: () =>
      apiFetch(`/payroll/runs/${id}/approve`, { method: 'POST', body: { confirm: true } }),
    onSuccess: () => {
      setConfirming(false);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => apiFetch(`/payroll/runs/${id}`, { method: 'DELETE' }),
    onSuccess: () => navigate('/payroll'),
  });
  const removeAdj = useMutation({
    mutationFn: (adjId) =>
      apiFetch(`/payroll/runs/${id}/adjustments/${adjId}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const pay = useMutation({
    mutationFn: (status) =>
      apiFetch(`/payroll/runs/${id}/payments`, {
        method: 'POST',
        body: { itemIds: selected, status, reference: reference || undefined },
      }),
    onSuccess: () => {
      setSelected([]);
      setReference('');
      refresh();
    },
  });

  if (q.isPending) return <Spinner />;
  if (q.error) return <ErrorMessage error={q.error} />;
  const run = q.data;
  const canManage = auth.can('payroll.manage');
  const editable = run.status !== 'approved';
  const month = run.period.start.slice(0, 7);

  return (
    <>
      <PageHeader
        title={`Payroll · ${run.period.label}`}
        description={`${run.period.start} to ${run.period.end}${run.branchName ? ` · ${run.branchName}` : ''}`}
        actions={<Badge tone={RUN_TONE[run.status]}>{run.status}</Badge>}
      />
      <PayrollNav />
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Employees', run.totals.employees],
          ['Gross', inr(run.totals.gross)],
          ['Deductions', inr(run.totals.deductions)],
          ['Net pay', inr(run.totals.net)],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm"
          >
            <p className="text-xs text-slate-500">{label}</p>
            <p className="mt-1 text-xl font-bold text-slate-900">{value}</p>
          </div>
        ))}
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {editable && canManage && (
          <>
            <Button onClick={() => calculate.mutate()} disabled={calculate.isPending}>
              {calculate.isPending
                ? 'Calculating…'
                : run.status === 'draft'
                  ? 'Calculate'
                  : 'Recalculate'}
            </Button>
            <Button variant="secondary" onClick={() => setAdding(true)}>
              Add adjustment
            </Button>
          </>
        )}
        {run.status === 'calculated' && auth.can('payroll.approve') && (
          <Button variant="secondary" onClick={() => setConfirming(true)}>
            Approve payroll
          </Button>
        )}
        {run.status === 'approved' && (
          <Button
            variant="secondary"
            onClick={() =>
              download(`/payroll/runs/${id}/payslips.zip`, `payslips-${month}.zip`, setError)
            }
          >
            Download all payslips (ZIP)
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={() =>
            download(`/payroll/runs/${id}/export.csv`, `payroll-${month}.csv`, setError)
          }
        >
          Export CSV
        </Button>
        {editable && canManage && (
          <Button variant="danger" onClick={() => remove.mutate()}>
            Delete run
          </Button>
        )}
      </div>

      <div className="mb-6 space-y-3">
        <ErrorMessage
          error={
            calculate.error ||
            approve.error ||
            remove.error ||
            pay.error ||
            removeAdj.error ||
            error
          }
        />
        {run.status === 'draft' && run.calculatedAt && (
          <Alert tone="amber">
            Adjustments changed since the last calculation. Recalculate before approving.
          </Alert>
        )}
        {run.status === 'approved' && (
          <Alert tone="green">
            Approved by {run.approvedBy} on {new Date(run.approvedAt).toLocaleDateString('en-IN')}.
            This payroll can no longer change; payslips are available to employees. Corrections go
            into a later month as adjustments.
          </Alert>
        )}
        {run.warnings?.length > 0 && (
          <Alert tone="amber">
            <p className="font-medium">Check before approving:</p>
            <ul className="ml-4 list-disc">
              {run.warnings.map((w, i) => (
                <li key={i}>{w.message}</li>
              ))}
            </ul>
          </Alert>
        )}
        {confirming && (
          <Alert tone="amber">
            <p className="font-medium">Approve payroll for {run.period.label}?</p>
            <p>
              {run.totals.employees} employees, net pay {inr(run.totals.net)}. After approval
              nothing in this payroll can be changed, and attendance and leave for the period are
              locked.
            </p>
            <div className="mt-2 flex gap-2">
              <Button onClick={() => approve.mutate()} disabled={approve.isPending}>
                Yes, approve
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </Alert>
        )}
      </div>

      {adding && <AdjustmentForm run={run} onDone={() => setAdding(false)} />}

      {run.adjustments.length > 0 && (
        <Card title="Adjustments" className="mb-6">
          <ul className="divide-y divide-slate-100 text-sm">
            {run.adjustments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {a.employeeName} · {a.label} · {a.kind === 'earning' ? '+' : '−'}
                  {inr(a.amount)}
                  <span className="block text-xs text-slate-500">{a.reason}</span>
                </span>
                {editable && canManage && (
                  <Button size="sm" variant="ghost" onClick={() => removeAdj.mutate(a.id)}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {run.status === 'approved' && auth.can('payroll.pay') && selected.length > 0 && (
        <Card title={`Record payment for ${selected.length} employee(s)`} className="mb-6">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Bank reference (optional)" htmlFor="pay-ref">
              <Input
                id="pay-ref"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                className="w-64"
              />
            </Field>
            <Button onClick={() => pay.mutate('paid')}>Mark paid</Button>
            <Button variant="secondary" onClick={() => pay.mutate('on_hold')}>
              On hold
            </Button>
            <Button variant="danger" onClick={() => pay.mutate('failed')}>
              Failed
            </Button>
          </div>
        </Card>
      )}

      <Card title="Employees">
        {run.items.length === 0 && <p className="text-sm text-slate-500">Not calculated yet.</p>}
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                {run.status === 'approved' && <th className="py-2 pr-2" />}
                <th className="py-2 pr-3">Employee</th>
                <th className="py-2 pr-3">LOP days</th>
                <th className="py-2 pr-3 text-right">Gross</th>
                <th className="py-2 pr-3 text-right">Deductions</th>
                <th className="py-2 pr-3 text-right">Net pay</th>
                <th className="py-2 pr-3">Payment</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {run.items.map((i) => (
                <Fragment key={i.id}>
                  <tr>
                    {run.status === 'approved' && (
                      <td className="py-1.5 pr-2">
                        <input
                          type="checkbox"
                          aria-label={`Select ${i.employee.fullName}`}
                          checked={selected.includes(i.id)}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, i.id]
                                : selected.filter((x) => x !== i.id),
                            )
                          }
                        />
                      </td>
                    )}
                    <td className="py-1.5 pr-3">
                      <button
                        type="button"
                        className="font-medium text-brand-700 hover:underline"
                        onClick={() => setOpen(open === i.id ? null : i.id)}
                      >
                        {i.employee.fullName}
                      </button>
                      <span className="block font-mono text-xs text-slate-500">
                        {i.employee.employeeNumber}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3">{i.metrics.lopDays}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{inr(i.grossEarnings)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{inr(i.totalDeductions)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono font-semibold">
                      {inr(i.netPay)}
                    </td>
                    <td className="py-1.5 pr-3">
                      <Badge tone={PAY_TONE[i.paymentStatus]}>{i.paymentStatus}</Badge>
                    </td>
                    <td className="py-1.5 text-right">
                      {run.status === 'approved' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            download(
                              `/payroll/runs/${id}/items/${i.id}/payslip.pdf`,
                              `payslip-${month}-${i.employee.employeeNumber}.pdf`,
                              setError,
                            )
                          }
                        >
                          Payslip
                        </Button>
                      )}
                    </td>
                  </tr>
                  {open === i.id && (
                    <tr>
                      <td colSpan={8} className="py-2">
                        <ItemLines item={i} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

// ================================================================== salaries

function StructureForm({ employee, components, current, onDone }) {
  const queryClient = useQueryClient();
  const fixed = components.filter((c) => c.calc === 'fixed' && c.status === 'active');
  const [from, setFrom] = useState('');
  const [note, setNote] = useState('');
  const [amounts, setAmounts] = useState(() =>
    Object.fromEntries(fixed.map((c) => [c.id, current?.amounts?.[c.id] ?? ''])),
  );
  const save = useMutation({
    mutationFn: () =>
      apiFetch('/payroll/structures', {
        method: 'POST',
        body: {
          employeeId: employee.id,
          effectiveFrom: from,
          note: note || undefined,
          lines: Object.entries(amounts)
            .filter(([, v]) => v !== '' && v !== null)
            .map(([componentId, amount]) => ({ componentId, amount: String(amount) })),
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payroll'] });
      onDone();
    },
  });
  const percents = components.filter(
    (c) => c.calc === 'percent_of_component' && c.status === 'active',
  );
  return (
    <Card title={`${current ? 'Revise' : 'Set'} salary: ${employee.fullName}`} className="mb-6">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-4">
          {fixed.map((c) => (
            <Field key={c.id} label={`${c.name} (${c.kind}) ₹/month`} htmlFor={`amt-${c.id}`}>
              <Input
                id={`amt-${c.id}`}
                inputMode="decimal"
                value={amounts[c.id]}
                onChange={(e) => setAmounts({ ...amounts, [c.id]: e.target.value })}
              />
            </Field>
          ))}
        </div>
        {percents.length > 0 && (
          <p className="text-xs text-slate-500">
            Calculated automatically:{' '}
            {percents
              .map(
                (c) =>
                  `${c.name} = ${c.percent}% of ${components.find((x) => x.id === c.baseComponentId)?.name}`,
              )
              .join('; ')}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="Effective from"
            htmlFor="st-from"
            hint={current ? 'The current salary ends the day before' : undefined}
          >
            <Input
              id="st-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label="Note (optional)" htmlFor="st-note">
            <Input
              id="st-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Annual increment"
            />
          </Field>
        </div>
        <ErrorMessage error={save.error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={save.isPending || !from}>
            Save salary
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function SalariesPage() {
  const auth = useAuth();
  const [editing, setEditing] = useState(null);
  const structures = useQuery({
    queryKey: ['payroll', 'structures'],
    queryFn: () => apiFetch('/payroll/structures'),
  });
  const components = useQuery({
    queryKey: ['payroll', 'components'],
    queryFn: () => apiFetch('/payroll/components'),
  });
  return (
    <>
      <PageHeader
        title="Salaries"
        description="Monthly salary per employee. Revisions are dated and keep history."
      />
      <PayrollNav />
      {components.data?.data.length === 0 && (
        <Alert tone="amber">
          Add salary components (for example Basic, HRA) in{' '}
          <Link to="/payroll/setup" className="underline">
            Payroll setup
          </Link>{' '}
          first.
        </Alert>
      )}
      {editing && components.data && (
        <StructureForm
          employee={editing.employee}
          current={editing.structure}
          components={components.data.data}
          onDone={() => setEditing(null)}
        />
      )}
      <Card>
        {structures.isPending && <Spinner />}
        <ErrorMessage error={structures.error} />
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-2 pr-3">Employee</th>
              <th className="py-2 pr-3">Fixed earnings / month</th>
              <th className="py-2 pr-3">Since</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {structures.data?.data.map((row) => (
              <tr key={row.employee.id}>
                <td className="py-1.5 pr-3">
                  {row.employee.fullName}{' '}
                  <span className="font-mono text-xs text-slate-500">
                    {row.employee.employeeNumber}
                  </span>
                </td>
                <td className="py-1.5 pr-3 font-mono">
                  {row.fixedEarnings ? inr(row.fixedEarnings) : <Badge tone="amber">not set</Badge>}
                </td>
                <td className="py-1.5 pr-3">{row.structure?.effectiveFrom ?? '—'}</td>
                <td className="py-1.5 text-right">
                  {auth.can('payroll.manage') && (
                    <Button size="sm" variant="secondary" onClick={() => setEditing(row)}>
                      {row.structure ? 'Revise' : 'Set salary'}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ================================================================== setup

function SettingsCard({ canManage }) {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['payroll', 'settings'],
    queryFn: () => apiFetch('/payroll/settings'),
  });
  const [form, setForm] = useState(null);
  const current = form ?? q.data;
  const save = useMutation({
    mutationFn: () =>
      apiFetch('/payroll/settings', {
        method: 'PUT',
        body: {
          dayRateBasis: current.dayRateBasis,
          fixedDays: current.dayRateBasis === 'fixed_days' ? Number(current.fixedDays) : null,
          incompleteDayLop: Number(current.incompleteDayLop),
          reducedHoursLop: Number(current.reducedHoursLop),
        },
      }),
    onSuccess: () => {
      setForm(null);
      queryClient.invalidateQueries({ queryKey: ['payroll'] });
    },
  });
  if (!current) return <Spinner />;
  const set = (k) => (e) => setForm({ ...current, [k]: e.target.value });
  return (
    <Card title="How a day's pay is calculated">
      <fieldset disabled={!canManage} className="grid gap-3 sm:grid-cols-4">
        <Field
          label="Day rate basis"
          htmlFor="ps-basis"
          hint="Monthly earnings ÷ this number of days"
        >
          <Select id="ps-basis" value={current.dayRateBasis} onChange={set('dayRateBasis')}>
            <option value="calendar_days">Calendar days in the month</option>
            <option value="working_days">Working days in the month</option>
            <option value="fixed_days">Fixed number of days</option>
          </Select>
        </Field>
        {current.dayRateBasis === 'fixed_days' && (
          <Field label="Days" htmlFor="ps-days">
            <Input
              id="ps-days"
              type="number"
              min="20"
              max="31"
              value={current.fixedDays ?? ''}
              onChange={set('fixedDays')}
            />
          </Field>
        )}
        <Field label="Missed check-out counts as" htmlFor="ps-inc">
          <Select
            id="ps-inc"
            value={String(current.incompleteDayLop)}
            onChange={set('incompleteDayLop')}
          >
            <option value="0">Paid (no deduction)</option>
            <option value="0.5">Half day loss of pay</option>
            <option value="1">Full day loss of pay</option>
          </Select>
        </Field>
        <Field label="Reduced hours counts as" htmlFor="ps-red">
          <Select
            id="ps-red"
            value={String(current.reducedHoursLop)}
            onChange={set('reducedHoursLop')}
          >
            <option value="0">Paid (no deduction)</option>
            <option value="0.5">Half day loss of pay</option>
            <option value="1">Full day loss of pay</option>
          </Select>
        </Field>
      </fieldset>
      <div className="mt-3 space-y-2">
        <ErrorMessage error={save.error} />
        {canManage && form && (
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            Save
          </Button>
        )}
      </div>
    </Card>
  );
}

function ComponentsCard({ components, canManage }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(null);
  const save = useMutation({
    mutationFn: () =>
      apiFetch('/payroll/components', {
        method: 'POST',
        body: {
          ...form,
          displayOrder: Number(form.displayOrder),
          percent: form.calc === 'percent_of_component' ? form.percent : null,
          baseComponentId: form.calc === 'percent_of_component' ? form.baseComponentId : null,
        },
      }),
    onSuccess: () => {
      setForm(null);
      queryClient.invalidateQueries({ queryKey: ['payroll'] });
    },
  });
  const toggle = useMutation({
    mutationFn: (c) =>
      apiFetch(`/payroll/components/${c.id}`, {
        method: 'PATCH',
        body: { status: c.status === 'active' ? 'inactive' : 'active' },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['payroll'] }),
  });
  const set = (k) => (e) =>
    setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Card
      title="Salary components"
      actions={
        canManage &&
        !form && (
          <Button
            size="sm"
            onClick={() =>
              setForm({
                name: '',
                code: '',
                kind: 'earning',
                calc: 'fixed',
                percent: '',
                baseComponentId: '',
                includeInDayRate: true,
                displayOrder: '100',
              })
            }
          >
            Add component
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
          <Field label="Name" htmlFor="pc-name">
            <Input id="pc-name" value={form.name} onChange={set('name')} placeholder="Basic" />
          </Field>
          <Field label="Code" htmlFor="pc-code">
            <Input
              id="pc-code"
              value={form.code}
              onChange={set('code')}
              placeholder="BASIC"
              className="uppercase"
            />
          </Field>
          <Field label="Type" htmlFor="pc-kind">
            <Select id="pc-kind" value={form.kind} onChange={set('kind')}>
              <option value="earning">Earning</option>
              <option value="deduction">Deduction</option>
            </Select>
          </Field>
          <Field label="Amount" htmlFor="pc-calc">
            <Select id="pc-calc" value={form.calc} onChange={set('calc')}>
              <option value="fixed">Fixed amount per employee</option>
              <option value="percent_of_component">Percent of another component</option>
            </Select>
          </Field>
          {form.calc === 'percent_of_component' && (
            <>
              <Field label="Percent" htmlFor="pc-pct">
                <Input
                  id="pc-pct"
                  inputMode="decimal"
                  value={form.percent}
                  onChange={set('percent')}
                />
              </Field>
              <Field label="Of component" htmlFor="pc-base">
                <Select id="pc-base" value={form.baseComponentId} onChange={set('baseComponentId')}>
                  <option value="">Choose…</option>
                  {components
                    .filter((c) => c.calc === 'fixed')
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </Select>
              </Field>
            </>
          )}
          <Field label="Order on payslip" htmlFor="pc-order">
            <Input
              id="pc-order"
              type="number"
              value={form.displayOrder}
              onChange={set('displayOrder')}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.includeInDayRate}
              onChange={set('includeInDayRate')}
            />{' '}
            Counts for day rate (loss of pay)
          </label>
          <div className="flex items-end gap-2 sm:col-span-4">
            <Button type="submit" disabled={save.isPending || form.name.length < 2 || !form.code}>
              Save
            </Button>
            <Button variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <ul className="divide-y divide-slate-100 text-sm">
        {components.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className={c.status === 'active' ? '' : 'text-slate-400'}>
              <span className="font-medium">{c.name}</span>{' '}
              <span className="font-mono text-xs">{c.code}</span>
              <span className="block text-xs text-slate-500">
                {c.kind} ·{' '}
                {c.calc === 'fixed'
                  ? 'fixed amount'
                  : `${c.percent}% of ${components.find((x) => x.id === c.baseComponentId)?.name}`}
                {c.kind === 'earning' && !c.includeInDayRate && ' · not in day rate'}
              </span>
            </span>
            {canManage && (
              <Button size="sm" variant="ghost" onClick={() => toggle.mutate(c)}>
                {c.status === 'active' ? 'Deactivate' : 'Activate'}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

const EMPTY_POLICY = {
  name: '',
  code: '',
  kind: 'deduction',
  calc: 'fixed',
  amount: '',
  percent: '',
  baseComponentId: '',
  unitMetric: 'lop_days',
  unitRate: 'day_rate',
  multiplier: '1',
  frequency: 'monthly',
  installments: '',
  effectiveFrom: new Date().toISOString().slice(0, 10),
};

function PoliciesCard({ components, canManage }) {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['payroll', 'policies'],
    queryFn: () => apiFetch('/payroll/policies'),
  });
  const [form, setForm] = useState(null);
  const save = useMutation({
    mutationFn: () =>
      apiFetch('/payroll/policies', {
        method: 'POST',
        body: {
          name: form.name,
          code: form.code,
          kind: form.kind,
          calc: form.calc,
          amount: form.calc === 'fixed' || form.unitRate === 'fixed_amount' ? form.amount : null,
          percent: form.calc === 'percent_of_component' ? form.percent : null,
          baseComponentId: form.calc === 'percent_of_component' ? form.baseComponentId : null,
          unitMetric: form.calc === 'per_unit' ? form.unitMetric : null,
          unitRate: form.calc === 'per_unit' ? form.unitRate : null,
          multiplier: form.multiplier || '1',
          frequency: form.frequency,
          installments: form.frequency === 'installments' ? Number(form.installments) : null,
          effectiveFrom: form.effectiveFrom,
        },
      }),
    onSuccess: () => {
      setForm(null);
      queryClient.invalidateQueries({ queryKey: ['payroll'] });
    },
  });
  const toggle = useMutation({
    mutationFn: (p) =>
      apiFetch(`/payroll/policies/${p.id}`, {
        method: 'PATCH',
        body: { status: p.status === 'active' ? 'inactive' : 'active' },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['payroll'] }),
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const describe = (p) => {
    if (p.calc === 'fixed') return `${inr(p.amount)} per month`;
    if (p.calc === 'percent_of_component')
      return `${p.percent}% of ${components.find((c) => c.id === p.baseComponentId)?.name ?? 'component'}`;
    const rate = p.unitRate === 'fixed_amount' ? inr(p.amount) : RATE_LABELS[p.unitRate];
    return `${METRIC_LABELS[p.unitMetric]} × ${rate}${p.multiplier !== '1' ? ` × ${p.multiplier}` : ''}`;
  };
  return (
    <Card
      title="Deductions and earnings rules"
      actions={
        canManage &&
        !form && (
          <Button size="sm" onClick={() => setForm(EMPTY_POLICY)}>
            Add rule
          </Button>
        )
      }
    >
      <p className="mb-3 text-xs text-slate-500">
        Loss of pay for absences and the late penalty from attendance rules are applied
        automatically. Add company rules here, for example a canteen deduction, salary advance
        recovery in instalments, or overtime pay.
      </p>
      <ErrorMessage error={q.error || save.error || toggle.error} />
      {form && (
        <form
          className="mb-4 grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Name" htmlFor="pp-name">
            <Input id="pp-name" value={form.name} onChange={set('name')} placeholder="Canteen" />
          </Field>
          <Field label="Code" htmlFor="pp-code">
            <Input id="pp-code" value={form.code} onChange={set('code')} className="uppercase" />
          </Field>
          <Field label="Type" htmlFor="pp-kind">
            <Select id="pp-kind" value={form.kind} onChange={set('kind')}>
              <option value="deduction">Deduction</option>
              <option value="earning">Earning</option>
            </Select>
          </Field>
          <Field label="Calculated as" htmlFor="pp-calc">
            <Select id="pp-calc" value={form.calc} onChange={set('calc')}>
              <option value="fixed">Fixed amount</option>
              <option value="percent_of_component">Percent of a component</option>
              <option value="per_unit">Per unit of attendance</option>
            </Select>
          </Field>
          {form.calc === 'fixed' && (
            <Field label="Amount (₹)" htmlFor="pp-amount">
              <Input
                id="pp-amount"
                inputMode="decimal"
                value={form.amount}
                onChange={set('amount')}
              />
            </Field>
          )}
          {form.calc === 'percent_of_component' && (
            <>
              <Field label="Percent" htmlFor="pp-pct">
                <Input
                  id="pp-pct"
                  inputMode="decimal"
                  value={form.percent}
                  onChange={set('percent')}
                />
              </Field>
              <Field label="Of component" htmlFor="pp-base">
                <Select id="pp-base" value={form.baseComponentId} onChange={set('baseComponentId')}>
                  <option value="">Choose…</option>
                  {components.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
          {form.calc === 'per_unit' && (
            <>
              <Field label="For each" htmlFor="pp-metric">
                <Select id="pp-metric" value={form.unitMetric} onChange={set('unitMetric')}>
                  {Object.entries(METRIC_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Multiply by" htmlFor="pp-rate">
                <Select id="pp-rate" value={form.unitRate} onChange={set('unitRate')}>
                  {Object.entries(RATE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </Field>
              {form.unitRate === 'fixed_amount' && (
                <Field label="Amount per unit (₹)" htmlFor="pp-unit-amount">
                  <Input
                    id="pp-unit-amount"
                    inputMode="decimal"
                    value={form.amount}
                    onChange={set('amount')}
                  />
                </Field>
              )}
              <Field label="Multiplier" htmlFor="pp-mult" hint="e.g. 1.5 for overtime">
                <Input
                  id="pp-mult"
                  inputMode="decimal"
                  value={form.multiplier}
                  onChange={set('multiplier')}
                />
              </Field>
            </>
          )}
          <Field label="How often" htmlFor="pp-freq">
            <Select id="pp-freq" value={form.frequency} onChange={set('frequency')}>
              <option value="monthly">Every month</option>
              <option value="one_time">One time</option>
              <option value="installments">Instalments</option>
            </Select>
          </Field>
          {form.frequency === 'installments' && (
            <Field label="Number of instalments" htmlFor="pp-inst">
              <Input
                id="pp-inst"
                type="number"
                min="1"
                value={form.installments}
                onChange={set('installments')}
              />
            </Field>
          )}
          <Field label="From" htmlFor="pp-from">
            <Input
              id="pp-from"
              type="date"
              value={form.effectiveFrom}
              onChange={set('effectiveFrom')}
            />
          </Field>
          <p className="sm:col-span-4 text-xs text-slate-500">
            Applies to all employees. Per-employee rules can be added through the API.
          </p>
          <div className="flex gap-2 sm:col-span-4">
            <Button type="submit" disabled={save.isPending || form.name.length < 2 || !form.code}>
              Save rule
            </Button>
            <Button variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <ul className="divide-y divide-slate-100 text-sm">
        {q.data?.data.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className={p.status === 'active' ? '' : 'text-slate-400'}>
              <span className="font-medium">{p.name}</span>{' '}
              <span className="font-mono text-xs">{p.code}</span> · {p.kind}
              <span className="block text-xs text-slate-500">
                {describe(p)} ·{' '}
                {p.frequency === 'installments'
                  ? `${p.installments} instalments`
                  : p.frequency.replace('_', ' ')}{' '}
                · from {p.effectiveFrom}
              </span>
            </span>
            {canManage && (
              <Button size="sm" variant="ghost" onClick={() => toggle.mutate(p)}>
                {p.status === 'active' ? 'Deactivate' : 'Activate'}
              </Button>
            )}
          </li>
        ))}
        {q.data?.data.length === 0 && (
          <li className="py-2 text-slate-500">No company rules yet.</li>
        )}
      </ul>
    </Card>
  );
}

export function PayrollSetupPage() {
  const auth = useAuth();
  const canManage = auth.can('payroll.manage');
  const components = useQuery({
    queryKey: ['payroll', 'components'],
    queryFn: () => apiFetch('/payroll/components'),
  });
  return (
    <>
      <PageHeader
        title="Payroll setup"
        description="Day rate, salary components and company pay rules."
      />
      <PayrollNav />
      <div className="space-y-6">
        <SettingsCard canManage={canManage} />
        {components.data && (
          <ComponentsCard components={components.data.data} canManage={canManage} />
        )}
        {components.data && (
          <PoliciesCard components={components.data.data} canManage={canManage} />
        )}
      </div>
    </>
  );
}

// ================================================================== employee: my payslips

export function MyPayslipsPage() {
  const [open, setOpen] = useState(null);
  const [error, setError] = useState(null);
  const q = useQuery({ queryKey: ['me', 'payslips'], queryFn: () => apiFetch('/me/payslips') });
  return (
    <>
      <PageHeader
        title="My payslips"
        description="Approved payslips with the full salary and deduction breakdown."
      />
      <ErrorMessage error={q.error || error} />
      {q.isPending && <Spinner />}
      {q.data?.data.length === 0 && <Card>No payslips yet.</Card>}
      <div className="space-y-3">
        {q.data?.data.map((p) => (
          <Card key={p.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-slate-900">{p.period.label}</p>
                <p className="text-sm text-slate-600">
                  Net pay <span className="font-mono font-semibold">{inr(p.netPay)}</span> · gross{' '}
                  {inr(p.grossEarnings)} · deductions {inr(p.totalDeductions)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={PAY_TONE[p.paymentStatus]}>
                  {p.paymentStatus === 'paid' ? 'paid' : 'payment pending'}
                </Badge>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setOpen(open === p.id ? null : p.id)}
                >
                  {open === p.id ? 'Hide details' : 'Details'}
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    apiDownload(
                      `/me/payslips/${p.id}/pdf`,
                      `payslip-${p.period.start.slice(0, 7)}.pdf`,
                    ).catch(setError)
                  }
                >
                  Download PDF
                </Button>
              </div>
            </div>
            {open === p.id && (
              <div className="mt-4">
                <ItemLines item={p} />
              </div>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
