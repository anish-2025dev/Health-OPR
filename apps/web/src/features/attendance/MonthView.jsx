import { Badge, Button, Card, Select } from '@/components/ui';
import { STATUS, fmtDate, fmtDuration, monthLabel, penaltyText, shiftMonth } from './format';

export function StatusBadge({ status }) {
  const meta = STATUS[status] ?? { label: status, tone: 'slate' };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function MonthPicker({ month, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        aria-label="Previous month"
        onClick={() => onChange(shiftMonth(month, -1))}
      >
        ←
      </Button>
      <span className="min-w-36 text-center text-sm font-medium text-slate-800">
        {monthLabel(month)}
      </span>
      <Button
        variant="secondary"
        size="sm"
        aria-label="Next month"
        onClick={() => onChange(shiftMonth(month, 1))}
      >
        →
      </Button>
    </div>
  );
}

function Stat({ label, value, tone = 'text-slate-900' }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${tone}`}>{value}</p>
    </div>
  );
}

export function MonthSummary({ data }) {
  const s = data.summary;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
      <Stat label="Present" value={s.present} tone="text-emerald-700" />
      <Stat label="Half days" value={s.halfDay} tone="text-amber-700" />
      <Stat label="Absent" value={s.absent + s.incomplete} tone="text-rose-700" />
      <Stat
        label="Late arrivals"
        value={s.late}
        tone={s.late ? 'text-amber-700' : 'text-slate-900'}
      />
      <Stat label="Overtime" value={fmtDuration(s.overtimeMinutes)} />
      <Stat label="Holidays" value={s.holiday} />
      <Stat label="Week offs" value={s.weekOff} />
    </div>
  );
}

/**
 * Month detail used by employees (own), managers and HR.
 * `onDayAction(day)` adds a per-day button (request correction / edit) when provided.
 */
export function MonthView({ data, dayActionLabel, onDayAction }) {
  const penalty = penaltyText(data.latePenalty);
  return (
    <div className="space-y-6">
      <MonthSummary data={data} />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card title="Daily log">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">In</th>
                  <th className="py-2 pr-3">Out</th>
                  <th className="py-2 pr-3">Hours</th>
                  <th className="py-2 pr-3">Late</th>
                  <th className="py-2 pr-3">OT</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.days
                  .filter((d) => d.status !== 'not_employed')
                  .map((d) => (
                    <tr key={d.date} className={d.status === 'upcoming' ? 'text-slate-400' : ''}>
                      <td className="py-1.5 pr-3 whitespace-nowrap">
                        {fmtDate(d.date)}
                        {d.holidayName && <p className="text-xs text-brand-700">{d.holidayName}</p>}
                        {/* In the first column so it stays reachable on narrow phone screens. */}
                        {onDayAction &&
                          !['upcoming', 'not_employed'].includes(d.status) &&
                          !(data.today && d.date > data.today) &&
                          !d.pendingRegularization && (
                            <button
                              type="button"
                              className="block text-xs font-medium text-brand-700 hover:underline"
                              onClick={() => onDayAction(d)}
                            >
                              {dayActionLabel}
                            </button>
                          )}
                      </td>
                      <td className="py-1.5 pr-3">
                        <div className="flex flex-wrap items-center gap-1">
                          <StatusBadge status={d.status} />
                          {d.leave && (
                            <span className="text-xs text-brand-700">
                              {d.leave.typeName}
                              {d.leave.fraction === 0.5 ? ' (½)' : ''}
                              {!d.leave.isPaid ? ' · unpaid' : ''}
                            </span>
                          )}
                          {d.statusSource && d.statusSource !== 'computed' && (
                            <span className="text-xs text-slate-400" title={d.manualReason ?? ''}>
                              ({d.statusSource === 'manual' ? 'edited' : 'corrected'})
                            </span>
                          )}
                          {d.pendingRegularization && <Badge tone="amber">request pending</Badge>}
                        </div>
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{d.checkIn ?? '—'}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{d.checkOut ?? '—'}</td>
                      <td className="py-1.5 pr-3">{fmtDuration(d.workedMinutes)}</td>
                      <td className="py-1.5 pr-3">
                        {d.isLate ? <span className="text-amber-700">{d.lateMinutes}m</span> : '—'}
                      </td>
                      <td className="py-1.5 pr-3">{fmtDuration(d.overtimeMinutes)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="space-y-6">
          <Card title="Late arrivals">
            {penalty && (
              <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {penalty}
              </p>
            )}
            <p className="mb-2 text-xs text-slate-500">
              Grace {data.policy.lateGraceMinutes} min · {data.policy.lateFreePerMonth} free per
              month
            </p>
            {data.lateEntries.length === 0 ? (
              <p className="text-sm text-slate-500">No late arrivals this month.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {data.lateEntries.map((l) => (
                  <li key={l.date} className="flex justify-between py-1.5">
                    <span>{fmtDate(l.date)}</span>
                    <span className="text-amber-700">
                      {l.checkIn} · {l.lateMinutes} min late
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Holidays this month">
            {data.holidays.length === 0 ? (
              <p className="text-sm text-slate-500">No holidays this month.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {data.holidays.map((h) => (
                  <li key={h.date} className="flex justify-between py-1.5">
                    <span>{h.name}</span>
                    <span className="text-slate-500">{fmtDate(h.date)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

export function StatusSelect(props) {
  return (
    <Select {...props}>
      <option value="">Keep calculated status</option>
      <option value="present">Present</option>
      <option value="half_day">Half day</option>
      <option value="reduced_hours">Reduced hours</option>
      <option value="absent">Absent</option>
      <option value="week_off">Week off</option>
      <option value="holiday">Holiday</option>
    </Select>
  );
}
