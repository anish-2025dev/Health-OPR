import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/features/auth/auth-context';
import { Button, Card, ErrorMessage, Input, PageHeader, Spinner } from '@/components/ui';
import { todayIst } from '@/features/clinic/format';

/** A headline number. */
function Stat({ label, value, hint }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-2xl font-semibold text-slate-900">{value ?? '—'}</p>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/**
 * Single-series horizontal bars: one brand hue, value labelled in text, hover title per bar.
 * Rows are already a readable table, so no separate legend is needed.
 */
function BarList({ rows, label, value, format = (v) => v, empty = 'No data for this period.' }) {
  if (!rows.length) return <p className="text-sm text-slate-500">{empty}</p>;
  const max = Math.max(...rows.map(value), 1);
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li
          key={label(r)}
          className="grid grid-cols-[minmax(7rem,1fr)_3fr_auto] items-center gap-3 text-sm"
          title={`${label(r)}: ${format(value(r))}`}
        >
          <span className="truncate text-slate-700">{label(r)}</span>
          <span className="h-3 rounded-r bg-slate-100">
            <span
              className="block h-3 rounded-r bg-brand-600"
              style={{ width: `${(value(r) / max) * 100}%`, minWidth: value(r) > 0 ? 4 : 0 }}
            />
          </span>
          <span className="text-right text-slate-700 tabular-nums">{format(value(r))}</span>
        </li>
      ))}
    </ul>
  );
}

const thisMonth = () => todayIst().slice(0, 7);
const SOURCE_LABEL = {
  reception: 'Reception',
  portal: 'Patient website',
  whatsapp: 'WhatsApp',
  walk_in: 'Walk-in',
  unknown: 'Other',
};

function Workforce() {
  const [month, setMonth] = useState(thisMonth());
  const q = useQuery({
    queryKey: ['analytics-workforce', month],
    queryFn: () => apiFetch(`/analytics/workforce?month=${month}`),
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        <Input
          aria-label="Month"
          type="month"
          className="w-44"
          value={month}
          onChange={(e) => e.target.value && setMonth(e.target.value)}
        />
      </div>
      {q.isPending && <Spinner />}
      <ErrorMessage error={q.error} />
      {d && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat
              label="Active employees"
              value={(d.headcount.active ?? 0) + (d.headcount.on_notice ?? 0)}
              hint={`${d.joiners} joined · ${d.exits} left this month`}
            />
            <Stat
              label="Days present"
              value={d.attendance.present}
              hint={`${d.attendance.halfDay} half days`}
            />
            <Stat label="Late arrivals" value={d.attendance.late} />
            <Stat
              label="Overtime"
              value={`${d.attendance.overtimeHours} h`}
              hint={`${d.attendance.workedHours} h worked`}
            />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Days present by department">
              <BarList
                rows={d.byDepartment}
                label={(r) => r.department}
                value={(r) => r.presentDays}
              />
            </Card>
            <Card title="Leave taken by type (days)">
              <BarList
                rows={d.leaveByType}
                label={(r) => r.type}
                value={(r) => r.days}
                empty="No approved leave in this month."
              />
              {d.pendingLeaveRequests > 0 && (
                <p className="mt-3 text-xs text-slate-500">
                  {d.pendingLeaveRequests} leave request(s) waiting for approval.
                </p>
              )}
            </Card>
            <Card title="Most late arrivals">
              <BarList
                rows={d.mostLate}
                label={(r) => `${r.fullName} (${r.employeeNumber})`}
                value={(r) => r.late}
                empty="Nobody was late."
              />
            </Card>
            <Card title="Overtime by department (hours)">
              <BarList
                rows={d.byDepartment.filter((r) => r.overtimeHours > 0)}
                label={(r) => r.department}
                value={(r) => r.overtimeHours}
                empty="No overtime recorded."
              />
            </Card>
          </div>
          <p className="text-xs text-slate-500">
            Figures count attendance days recorded in the app. Days with no record (for example
            someone who never marked attendance) are not counted as absences here.
          </p>
        </div>
      )}
    </>
  );
}

function Clinic() {
  const today = todayIst();
  const [range, setRange] = useState({ from: `${today.slice(0, 7)}-01`, to: today });
  const q = useQuery({
    queryKey: ['analytics-clinic', range],
    queryFn: () => apiFetch(`/analytics/clinic?from=${range.from}&to=${range.to}`),
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  const hourLabel = (h) => `${((h + 11) % 12) + 1} ${h < 12 ? 'am' : 'pm'}`;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          aria-label="From"
          type="date"
          className="w-44"
          value={range.from}
          onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })}
        />
        <span className="text-sm text-slate-500">to</span>
        <Input
          aria-label="To"
          type="date"
          className="w-44"
          value={range.to}
          onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })}
        />
      </div>
      {q.isPending && <Spinner />}
      <ErrorMessage error={q.error} />
      {d && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat
              label="Patients seen"
              value={d.totals.seen}
              hint={`${d.totals.bookings} bookings · ${d.totals.walkIns} walk-ins`}
            />
            <Stat
              label="No-show rate"
              value={d.totals.noShowRate != null ? `${d.totals.noShowRate}%` : '—'}
              hint={`${d.totals.noShows} no-shows · ${d.totals.cancelled} cancelled`}
            />
            <Stat
              label="Average wait"
              value={
                d.totals.averageWaitMinutes != null ? `${d.totals.averageWaitMinutes} min` : '—'
              }
              hint="Arrival to being called"
            />
            <Stat
              label="Average consultation"
              value={
                d.totals.averageConsultationMinutes != null
                  ? `${d.totals.averageConsultationMinutes} min`
                  : '—'
              }
            />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Patients seen per day">
              <BarList
                rows={d.daily}
                label={(r) =>
                  new Date(`${r.date}T00:00:00`).toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                  })
                }
                value={(r) => r.seen}
              />
            </Card>
            <Card title="Busiest arrival hours">
              <BarList
                rows={d.arrivalsByHour}
                label={(r) => hourLabel(r.hour)}
                value={(r) => r.arrivals}
              />
            </Card>
            <Card title="Patients seen by doctor">
              <BarList rows={d.byDoctor} label={(r) => r.doctor} value={(r) => r.seen} />
            </Card>
            <Card title="How patients booked">
              <BarList
                rows={Object.entries(d.bySource).map(([k, v]) => ({ k, v }))}
                label={(r) => SOURCE_LABEL[r.k] ?? r.k}
                value={(r) => r.v}
              />
              <p className="mt-3 text-xs text-slate-500">
                New patients registered:{' '}
                {Object.entries(d.newPatients)
                  .map(([k, v]) => `${v} at ${k === 'portal' ? 'the patient website' : k}`)
                  .join(', ') || 'none'}
              </p>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

export function AnalyticsPage() {
  const auth = useAuth();
  const tabs = [
    auth.can('appointments.read') && ['clinic', 'Clinic'],
    auth.can('employees.read') && auth.can('attendance.read') && ['workforce', 'Workforce'],
  ].filter(Boolean);
  const [tab, setTab] = useState(tabs[0]?.[0]);
  return (
    <>
      <PageHeader title="Analytics" description="Trends for your clinic and your team." />
      {tabs.length > 1 && (
        <div className="mb-4 flex gap-2" role="tablist">
          {tabs.map(([k, label]) => (
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
      )}
      {tab === 'clinic' && <Clinic />}
      {tab === 'workforce' && <Workforce />}
    </>
  );
}
