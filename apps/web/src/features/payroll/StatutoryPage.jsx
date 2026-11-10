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
import { inr } from './format';

const TYPE_LABEL = {
  epf: 'Provident fund (EPF)',
  esi: 'Employees’ State Insurance (ESI)',
  professional_tax: 'Professional tax',
  lwf: 'Labour welfare fund',
  gratuity: 'Gratuity (tracking)',
};
const STATUS_TONE = { draft: 'amber', approved: 'green', retired: 'slate' };

function describe(rule) {
  const c = rule.config;
  switch (rule.ruleType) {
    case 'epf':
      return `Employee ${c.employeeRatePercent}%, employer ${c.employerRatePercent}% of ${c.wageComponentCodes.join(' + ')}${c.wageCeiling ? `, wages capped at ${inr(c.wageCeiling)}` : ''}; rounding ${c.rounding.replace('_', ' ')}`;
    case 'esi':
      return `Employee ${c.employeeRatePercent}%, employer ${c.employerRatePercent}% of gross${c.eligibilityGrossCeiling ? `, if gross ≤ ${inr(c.eligibilityGrossCeiling)}` : ''}; rounding ${c.rounding.replace('_', ' ')}`;
    case 'professional_tax':
      return `${c.slabs.map((s) => `${inr(s.fromGross)}–${s.toGross ? inr(s.toGross) : 'above'}: ${inr(s.amount)}`).join(' · ')}${c.monthOverrides?.length ? ` · overrides: ${c.monthOverrides.map((o) => `month ${o.month} ${inr(o.amount)}`).join(', ')}` : ''}`;
    case 'lwf':
      return `Employee ${inr(c.employeeAmount)}, employer ${inr(c.employerAmount)} in months ${c.months.join(', ')}`;
    case 'gratuity':
      return `${c.daysPerYear} days' wages per year (÷ ${c.divisorDays}) of ${c.wageComponentCodes.join(' + ')}, after ${c.minServiceYears} years`;
    default:
      return '';
  }
}

const EMPTY = {
  ruleType: 'epf',
  jurisdiction: 'IN',
  effectiveFrom: '',
  sourceReference: '',
  employeeRatePercent: '',
  employerRatePercent: '',
  wageComponentCodes: 'BASIC',
  wageCeiling: '',
  eligibilityGrossCeiling: '',
  rounding: 'nearest_rupee',
  slabs: '',
  monthOverrides: '',
  employeeAmount: '',
  employerAmount: '',
  months: '',
  daysPerYear: '',
  divisorDays: '',
  minServiceYears: '',
};

/** Parses "0-9999.99:0; 10000-:200" into PT slabs. */
const parseSlabs = (text) =>
  text
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [range, amount] = s.split(':').map((x) => x.trim());
      const [from, to] = range.split('-').map((x) => x.trim());
      return { fromGross: from, toGross: to || null, amount };
    });
const parseOverrides = (text) =>
  text
    .split(/[;,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [month, amount] = s.split(':').map((x) => x.trim());
      return { month: Number(month), amount };
    });
const codes = (text) =>
  text
    .split(/[,+\s]+/)
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
const nums = (text) =>
  text
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);

function toConfig(f) {
  switch (f.ruleType) {
    case 'epf':
      return {
        employeeRatePercent: f.employeeRatePercent,
        employerRatePercent: f.employerRatePercent,
        wageComponentCodes: codes(f.wageComponentCodes),
        wageCeiling: f.wageCeiling || null,
        rounding: f.rounding,
      };
    case 'esi':
      return {
        employeeRatePercent: f.employeeRatePercent,
        employerRatePercent: f.employerRatePercent,
        eligibilityGrossCeiling: f.eligibilityGrossCeiling || null,
        rounding: f.rounding,
      };
    case 'professional_tax':
      return { slabs: parseSlabs(f.slabs), monthOverrides: parseOverrides(f.monthOverrides) };
    case 'lwf':
      return {
        employeeAmount: f.employeeAmount,
        employerAmount: f.employerAmount,
        months: nums(f.months),
      };
    case 'gratuity':
      return {
        daysPerYear: Number(f.daysPerYear),
        divisorDays: Number(f.divisorDays),
        minServiceYears: Number(f.minServiceYears),
        wageComponentCodes: codes(f.wageComponentCodes),
      };
    default:
      return {};
  }
}

function RuleForm({ onDone }) {
  const queryClient = useQueryClient();
  const [f, setF] = useState(EMPTY);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const stateRule = ['professional_tax', 'lwf'].includes(f.ruleType);
  const save = useMutation({
    mutationFn: () =>
      apiFetch('/payroll/statutory/rules', {
        method: 'POST',
        body: {
          ruleType: f.ruleType,
          jurisdiction: stateRule ? f.jurisdiction.toUpperCase() : 'IN',
          effectiveFrom: f.effectiveFrom,
          sourceReference: f.sourceReference,
          config: toConfig(f),
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['statutory'] });
      onDone();
    },
  });
  return (
    <Card title="New rule version (draft)" className="mb-6">
      <Alert tone="amber">
        Enter the values from the official notification or your payroll adviser. HealthOS does not
        supply statutory rates. A rule is applied only after it is approved.
      </Alert>
      <form
        className="mt-4 grid gap-3 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Rule" htmlFor="sr-type">
          <Select id="sr-type" value={f.ruleType} onChange={set('ruleType')}>
            {Object.entries(TYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        {stateRule && (
          <Field label="State code" htmlFor="sr-state" hint="e.g. KA, MH">
            <Input
              id="sr-state"
              value={f.jurisdiction === 'IN' ? '' : f.jurisdiction}
              onChange={set('jurisdiction')}
              maxLength={2}
              className="uppercase"
            />
          </Field>
        )}
        <Field label="Effective from" htmlFor="sr-from">
          <Input id="sr-from" type="date" value={f.effectiveFrom} onChange={set('effectiveFrom')} />
        </Field>
        <Field
          label="Source reference"
          htmlFor="sr-src"
          hint="Notification / circular / adviser memo"
        >
          <Input id="sr-src" value={f.sourceReference} onChange={set('sourceReference')} />
        </Field>
        {['epf', 'esi'].includes(f.ruleType) && (
          <>
            <Field label="Employee rate (%)" htmlFor="sr-ee">
              <Input
                id="sr-ee"
                inputMode="decimal"
                value={f.employeeRatePercent}
                onChange={set('employeeRatePercent')}
              />
            </Field>
            <Field label="Employer rate (%)" htmlFor="sr-er">
              <Input
                id="sr-er"
                inputMode="decimal"
                value={f.employerRatePercent}
                onChange={set('employerRatePercent')}
              />
            </Field>
            <Field label="Rounding" htmlFor="sr-round">
              <Select id="sr-round" value={f.rounding} onChange={set('rounding')}>
                <option value="none">To the paisa</option>
                <option value="nearest_rupee">Nearest rupee</option>
                <option value="up_rupee">Up to the next rupee</option>
              </Select>
            </Field>
          </>
        )}
        {f.ruleType === 'epf' && (
          <>
            <Field label="Wage components (codes)" htmlFor="sr-codes" hint="e.g. BASIC, DA">
              <Input
                id="sr-codes"
                value={f.wageComponentCodes}
                onChange={set('wageComponentCodes')}
              />
            </Field>
            <Field label="Wage ceiling (₹, optional)" htmlFor="sr-ceil">
              <Input
                id="sr-ceil"
                inputMode="decimal"
                value={f.wageCeiling}
                onChange={set('wageCeiling')}
              />
            </Field>
          </>
        )}
        {f.ruleType === 'esi' && (
          <Field label="Eligible if monthly gross ≤ (₹)" htmlFor="sr-elig">
            <Input
              id="sr-elig"
              inputMode="decimal"
              value={f.eligibilityGrossCeiling}
              onChange={set('eligibilityGrossCeiling')}
            />
          </Field>
        )}
        {f.ruleType === 'professional_tax' && (
          <>
            <div className="sm:col-span-2">
              <Field
                label="Slabs on monthly gross"
                htmlFor="sr-slabs"
                hint="from-to:amount, separated by ;  (leave 'to' empty for the top slab)"
              >
                <Input
                  id="sr-slabs"
                  value={f.slabs}
                  onChange={set('slabs')}
                  placeholder="0-9999.99:0; 10000-:…"
                />
              </Field>
            </div>
            <Field
              label="Month overrides (optional)"
              htmlFor="sr-over"
              hint="month:amount, e.g. 2:…"
            >
              <Input id="sr-over" value={f.monthOverrides} onChange={set('monthOverrides')} />
            </Field>
          </>
        )}
        {f.ruleType === 'lwf' && (
          <>
            <Field label="Employee amount (₹)" htmlFor="sr-lee">
              <Input
                id="sr-lee"
                inputMode="decimal"
                value={f.employeeAmount}
                onChange={set('employeeAmount')}
              />
            </Field>
            <Field label="Employer amount (₹)" htmlFor="sr-ler">
              <Input
                id="sr-ler"
                inputMode="decimal"
                value={f.employerAmount}
                onChange={set('employerAmount')}
              />
            </Field>
            <Field label="Deducted in months" htmlFor="sr-months" hint="e.g. 6, 12">
              <Input id="sr-months" value={f.months} onChange={set('months')} />
            </Field>
          </>
        )}
        {f.ruleType === 'gratuity' && (
          <>
            <Field label="Days' wages per year" htmlFor="sr-dpy">
              <Input
                id="sr-dpy"
                inputMode="decimal"
                value={f.daysPerYear}
                onChange={set('daysPerYear')}
              />
            </Field>
            <Field label="Divided by days" htmlFor="sr-div">
              <Input
                id="sr-div"
                type="number"
                value={f.divisorDays}
                onChange={set('divisorDays')}
              />
            </Field>
            <Field label="Minimum service (years)" htmlFor="sr-min">
              <Input
                id="sr-min"
                inputMode="decimal"
                value={f.minServiceYears}
                onChange={set('minServiceYears')}
              />
            </Field>
            <Field label="Wage components (codes)" htmlFor="sr-gcodes">
              <Input
                id="sr-gcodes"
                value={f.wageComponentCodes}
                onChange={set('wageComponentCodes')}
              />
            </Field>
          </>
        )}
        <div className="sm:col-span-4 space-y-2">
          <ErrorMessage error={save.error} />
          {save.error?.details && (
            <ul className="ml-4 list-disc text-xs text-rose-700">
              {save.error.details.map((d, i) => (
                <li key={i}>
                  {d.field}: {d.message}
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={save.isPending || !f.effectiveFrom || f.sourceReference.length < 3}
            >
              Save draft
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

function Rules() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [ending, setEnding] = useState(null);
  const [endDate, setEndDate] = useState('');
  const q = useQuery({
    queryKey: ['statutory', 'rules'],
    queryFn: () => apiFetch('/payroll/statutory/rules'),
  });
  const act = useMutation({
    mutationFn: ({ id, action, body, method = 'POST' }) =>
      apiFetch(`/payroll/statutory/rules/${id}${action ? `/${action}` : ''}`, { method, body }),
    onSuccess: () => {
      setEnding(null);
      queryClient.invalidateQueries({ queryKey: ['statutory'] });
    },
  });
  return (
    <>
      {adding && <RuleForm onDone={() => setAdding(false)} />}
      <Card
        title="Rule versions"
        actions={
          auth.can('payroll.manage') &&
          !adding && (
            <Button size="sm" onClick={() => setAdding(true)}>
              New rule version
            </Button>
          )
        }
      >
        {q.isPending && <Spinner />}
        <ErrorMessage error={q.error || act.error} />
        {q.data?.data.length === 0 && (
          <p className="text-sm text-slate-500">
            No statutory rules yet. Payroll runs without statutory deductions until rules are
            approved.
          </p>
        )}
        <ul className="divide-y divide-slate-100 text-sm">
          {q.data?.data.map((r) => (
            <li key={r.id} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-slate-800">
                    {TYPE_LABEL[r.ruleType]}
                    {r.jurisdiction !== 'IN' && ` · ${r.jurisdiction}`}{' '}
                    <Badge tone={STATUS_TONE[r.approvalStatus]}>{r.approvalStatus}</Badge>
                  </p>
                  <p className="text-slate-600">{describe(r)}</p>
                  <p className="text-xs text-slate-400">
                    From {r.effectiveFrom}
                    {r.effectiveTo ? ` to ${r.effectiveTo}` : ''} · source: {r.sourceReference}
                    {r.approvedBy ? ` · approved by ${r.approvedBy}` : ''}
                  </p>
                </div>
                <div className="flex gap-2">
                  {r.approvalStatus === 'draft' && auth.can('payroll.approve') && (
                    <Button size="sm" onClick={() => act.mutate({ id: r.id, action: 'approve' })}>
                      Approve
                    </Button>
                  )}
                  {r.approvalStatus === 'draft' && auth.can('payroll.manage') && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => act.mutate({ id: r.id, method: 'DELETE' })}
                    >
                      Delete
                    </Button>
                  )}
                  {r.approvalStatus === 'approved' &&
                    !r.effectiveTo &&
                    auth.can('payroll.approve') && (
                      <Button size="sm" variant="secondary" onClick={() => setEnding(r.id)}>
                        End on…
                      </Button>
                    )}
                </div>
              </div>
              {ending === r.id && (
                <form
                  className="mt-2 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act.mutate({ id: r.id, action: 'end', body: { effectiveTo: endDate } });
                  }}
                >
                  <Input
                    type="date"
                    aria-label="End date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-44"
                  />
                  <Button type="submit" size="sm" disabled={!endDate}>
                    End rule
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

function EnrolmentRow({ row, canManage }) {
  const queryClient = useQueryClient();
  const [s, setS] = useState(row.statutory);
  const [dirty, setDirty] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/payroll/statutory/employees/${row.employee.id}`, {
        method: 'PUT',
        body: {
          pfApplicable: s.pfApplicable,
          esiApplicable: s.esiApplicable,
          lwfApplicable: s.lwfApplicable,
          ptState: s.ptState || null,
          tdsMonthlyAmount: s.tdsMonthlyAmount || null,
        },
      }),
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ['statutory'] });
    },
  });
  const set = (k, v) => {
    setDirty(true);
    setS({ ...s, [k]: v });
  };
  return (
    <tr>
      <td className="py-1.5 pr-3">
        {row.employee.fullName}{' '}
        <span className="font-mono text-xs text-slate-500">{row.employee.employeeNumber}</span>
      </td>
      {['pfApplicable', 'esiApplicable', 'lwfApplicable'].map((k) => (
        <td key={k} className="py-1.5 pr-3">
          <input
            type="checkbox"
            aria-label={`${k} ${row.employee.fullName}`}
            disabled={!canManage}
            checked={s[k]}
            onChange={(e) => set(k, e.target.checked)}
          />
        </td>
      ))}
      <td className="py-1.5 pr-3">
        <Input
          aria-label={`PT state ${row.employee.fullName}`}
          disabled={!canManage}
          value={s.ptState ?? ''}
          maxLength={2}
          className="w-16 uppercase"
          onChange={(e) => set('ptState', e.target.value.toUpperCase())}
        />
      </td>
      <td className="py-1.5 pr-3">
        <Input
          aria-label={`TDS ${row.employee.fullName}`}
          disabled={!canManage}
          inputMode="decimal"
          value={s.tdsMonthlyAmount ?? ''}
          className="w-28"
          onChange={(e) => set('tdsMonthlyAmount', e.target.value)}
        />
      </td>
      <td className="py-1.5 text-right">
        {dirty && (
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            Save
          </Button>
        )}
        {save.error && <span className="text-xs text-rose-600">{save.error.message}</span>}
      </td>
    </tr>
  );
}

function Enrolment() {
  const auth = useAuth();
  const q = useQuery({
    queryKey: ['statutory', 'employees'],
    queryFn: () => apiFetch('/payroll/statutory/employees'),
  });
  return (
    <Card title="Employee enrolment">
      <p className="mb-3 text-xs text-slate-500">
        Tick what applies to each employee. Professional tax and LWF use the employee’s state code.
        TDS is the monthly amount payroll calculates from the employee’s tax declaration (income-tax
        computation is not automated in the pilot).
      </p>
      <ErrorMessage error={q.error} />
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-2 pr-3">Employee</th>
              <th className="py-2 pr-3">PF</th>
              <th className="py-2 pr-3">ESI</th>
              <th className="py-2 pr-3">LWF</th>
              <th className="py-2 pr-3">PT state</th>
              <th className="py-2 pr-3">TDS / month (₹)</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {q.data?.data.map((row) => (
              <EnrolmentRow
                key={row.employee.id}
                row={row}
                canManage={auth.can('payroll.manage')}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Gratuity() {
  const q = useQuery({
    queryKey: ['statutory', 'gratuity'],
    queryFn: () => apiFetch('/payroll/statutory/gratuity'),
  });
  if (!q.data) return null;
  return (
    <Card title="Gratuity liability (estimate)">
      {!q.data.rule ? (
        <p className="text-sm text-slate-500">
          Add and approve a gratuity tracking rule to see estimates.
        </p>
      ) : (
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-2 pr-3">Employee</th>
              <th className="py-2 pr-3">Joined</th>
              <th className="py-2 pr-3">Completed years</th>
              <th className="py-2 pr-3">Eligible</th>
              <th className="py-2 pr-3 text-right">Estimated liability</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {q.data.data.map((r) => (
              <tr key={r.employee.id}>
                <td className="py-1.5 pr-3">{r.employee.fullName}</td>
                <td className="py-1.5 pr-3">{r.employee.joiningDate}</td>
                <td className="py-1.5 pr-3">{r.completedYears}</td>
                <td className="py-1.5 pr-3">
                  {r.eligible ? <Badge tone="green">yes</Badge> : <Badge>not yet</Badge>}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono">{inr(r.estimatedAmount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function StatutoryPage() {
  return (
    <>
      <PageHeader
        title="Statutory payroll"
        description="PF, ESI, professional tax, LWF, TDS and gratuity, using rules your organization enters and approves."
      />
      <div className="space-y-6">
        <Rules />
        <Enrolment />
        <Gratuity />
      </div>
    </>
  );
}
