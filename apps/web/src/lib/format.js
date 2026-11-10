/** Formats a UTC timestamp in the organization's timezone (data is stored in UTC). */
export function formatDateTime(value, timeZone = 'Asia/Kolkata') {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(value));
}
