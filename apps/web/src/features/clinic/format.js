export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const QUEUE_STATUS = {
  booked: ['Not arrived', 'slate'],
  waiting: ['Waiting', 'amber'],
  called: ['Called', 'brand'],
  in_consultation: ['With doctor', 'brand'],
  completed: ['Done', 'green'],
  no_show: ['No-show', 'red'],
  cancelled: ['Cancelled', 'red'],
};

export const PRIORITY = { 0: 'Normal', 1: 'Priority', 2: 'Urgent' };

/** Clinic times are shown in the clinic's timezone (India for the pilot), whatever the device says. */
export const CLINIC_TZ = 'Asia/Kolkata';

export const timeOf = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: CLINIC_TZ,
      })
    : '—';

/** Today's date (YYYY-MM-DD) in India. Branch timezones other than IST use the API's own date. */
export const todayIst = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

export const trackingUrl = (code) => {
  const base = import.meta.env.VITE_PATIENT_SITE_URL || window.location.origin;
  return `${base.replace(/\/$/, '')}/track/${code}`;
};

export function waitText(minutes) {
  if (minutes == null) return null;
  if (minutes <= 0) return 'You are next';
  if (minutes < 60) return `About ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `About ${h} h ${m ? `${m} min` : ''}`.trim();
}
