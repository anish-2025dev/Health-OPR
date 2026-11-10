import { useAuth } from '@/features/auth/auth-context';
import { PageHeader } from '@/components/ui';
import { SystemStatus } from '@/features/system-status/SystemStatus';

const UPCOMING = [
  'Employees & departments',
  'Patient registration',
  'Attendance (QR check-in)',
  'Appointments & queue',
  'Leave',
  'Payroll & payslips',
];

export function DashboardPage() {
  const { me } = useAuth();
  return (
    <>
      <PageHeader
        title={`Welcome, ${me.user.fullName.split(' ')[0]}`}
        description={`${me.organization.name} · ${me.roles.map((r) => r.label).join(', ')}`}
      />
      <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">Coming next</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {UPCOMING.map((name) => (
              <li
                key={name}
                className="rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-500"
              >
                {name}
              </li>
            ))}
          </ul>
        </section>
        <SystemStatus />
      </div>
    </>
  );
}
