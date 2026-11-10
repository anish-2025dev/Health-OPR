import { Link } from 'react-router';
import { useAuth } from '@/features/auth/auth-context';
import { PageHeader } from '@/components/ui';
import { SystemStatus } from '@/features/system-status/SystemStatus';

/** Shortcuts to each person's main tasks, using the same permission rules as the menu. */
const SHORTCUTS = [
  {
    to: '/reception',
    label: 'Reception & queue',
    hint: 'Book, add walk-ins, call the next patient',
    show: (a) => a.can('appointments.manage'),
  },
  {
    to: '/reception',
    label: 'My queue',
    hint: 'Call, start and finish consultations',
    show: (a) => a.can('queue.manage') && !a.can('appointments.manage'),
  },
  {
    to: '/clinic',
    label: 'Clinic today',
    hint: 'Live numbers for each doctor',
    show: (a) => a.can('appointments.read'),
  },
  {
    to: '/patients',
    label: 'Patients',
    hint: 'Find or register a patient',
    show: (a) => a.can('patients.read'),
  },
  {
    to: '/attendance',
    label: 'Attendance',
    hint: 'Who is in, late or on leave today',
    show: (a) => a.can('attendance.read'),
  },
  {
    to: '/leave',
    label: 'Leave',
    hint: 'Requests waiting for approval',
    show: (a) => a.can('leave.read') || Boolean(a.me.employee?.isManager),
  },
  {
    to: '/payroll',
    label: 'Payroll',
    hint: 'Runs, payslips and salaries',
    show: (a) => a.can('payroll.read'),
  },
  {
    to: '/employees',
    label: 'Employees',
    hint: 'Profiles, shifts and reporting lines',
    show: (a) => a.can('employees.read'),
  },
  {
    to: '/analytics',
    label: 'Analytics',
    hint: 'Trends for the clinic and the team',
    show: (a) =>
      a.can('appointments.read') || (a.can('employees.read') && a.can('attendance.read')),
  },
  {
    to: '/my-attendance',
    label: 'My attendance',
    hint: 'Check in or out',
    show: (a) => Boolean(a.me.employee),
  },
];

export function DashboardPage() {
  const auth = useAuth();
  const { me } = auth;
  const shortcuts = SHORTCUTS.filter((s) => s.show(auth)).slice(0, 6);
  return (
    <>
      <PageHeader
        title={`Welcome, ${me.user.fullName.split(' ')[0]}`}
        description={`${me.organization.name} · ${me.roles.map((r) => r.label).join(', ')}`}
      />
      <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">Go to</h2>
          {shortcuts.length === 0 && (
            <p className="mt-3 text-sm text-slate-500">Use the menu to open your sections.</p>
          )}
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {shortcuts.map((s) => (
              <li key={s.label}>
                <Link
                  to={s.to}
                  className="block rounded-lg border border-slate-200 px-3 py-2 hover:border-brand-600 hover:bg-brand-50"
                >
                  <span className="text-sm font-medium text-slate-800">{s.label}</span>
                  <span className="block text-xs text-slate-500">{s.hint}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <SystemStatus />
      </div>
    </>
  );
}
