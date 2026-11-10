export const STATUS = {
  present: { label: 'Present', tone: 'green' },
  half_day: { label: 'Half day', tone: 'amber' },
  reduced_hours: { label: 'Reduced hours', tone: 'amber' },
  absent: { label: 'Absent', tone: 'red' },
  incomplete: { label: 'No check-out', tone: 'red' },
  checked_in: { label: 'Checked in', tone: 'brand' },
  not_checked_in: { label: 'Not checked in', tone: 'slate' },
  week_off: { label: 'Week off', tone: 'slate' },
  holiday: { label: 'Holiday', tone: 'brand' },
  leave: { label: 'Leave', tone: 'brand' },
  upcoming: { label: '—', tone: 'slate' },
  not_employed: { label: '—', tone: 'slate' },
};

export const EDITABLE_STATUSES = [
  'present',
  'half_day',
  'reduced_hours',
  'absent',
  'week_off',
  'holiday',
];

export const fmtDuration = (mins) => {
  if (!mins) return '—';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h${m ? ` ${String(m).padStart(2, '0')}m` : ''}` : `${m}m`;
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const fmtDate = (iso) => {
  const date = new Date(`${iso}T00:00:00Z`);
  const month = date.toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' });
  return `${DAY_NAMES[date.getUTCDay()]} ${date.getUTCDate()} ${month}`;
};

export const currentMonth = () => new Date().toISOString().slice(0, 7);
export const shiftMonth = (month, delta) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
};
export const monthLabel = (month) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

export function penaltyText(p) {
  if (!p || p.mode === 'none') return null;
  if (p.mode === 'fixed_amount')
    return `₹${p.amount} late penalty (${p.penalizedLates} beyond ${p.freeAllowed} allowed)`;
  return `${p.deductionDays} day(s) deduction for late arrivals (${p.penalizedLates} beyond ${p.freeAllowed} allowed)`;
}
