/** Formats a decimal string as Indian rupees with lakh/crore grouping, without float arithmetic. */
export function inr(amount) {
  if (amount === null || amount === undefined) return '—';
  const s = String(amount);
  const negative = s.startsWith('-');
  const [r, p = '00'] = s.replace('-', '').split('.');
  const last3 = r.slice(-3);
  const rest = r.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${negative ? '-' : ''}₹${grouped}.${p.padEnd(2, '0')}`;
}

export const RUN_TONE = { draft: 'amber', calculated: 'brand', approved: 'green' };
export const PAY_TONE = { pending: 'slate', paid: 'green', failed: 'red', on_hold: 'amber' };

export const METRIC_LABELS = {
  lop_days: 'Loss-of-pay days',
  absent_days: 'Absent days',
  half_days: 'Half days',
  late_beyond_free: 'Late arrivals beyond the free count',
  reduced_hour_days: 'Reduced-hour days',
  overtime_hours: 'Overtime hours',
  incomplete_days: 'Missed check-outs',
};
export const RATE_LABELS = {
  fixed_amount: 'a fixed amount',
  day_rate: "one day's pay",
  hourly_rate: "one hour's pay",
};
