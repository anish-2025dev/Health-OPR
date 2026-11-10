import { NavLink, Outlet } from 'react-router';
import { useAuth } from '@/features/auth/auth-context';
import { Button } from '@/components/ui';

const NAV = [
  {
    to: '/',
    label: 'Dashboard',
    end: true,
    show: (a) => !a.me.roles.every((r) => r.role === 'employee'),
  },
  { to: '/my-attendance', label: 'My attendance', show: (a) => Boolean(a.me.employee) },
  { to: '/my-leave', label: 'My leave', show: (a) => Boolean(a.me.employee) },
  { to: '/attendance', label: 'Attendance', permission: 'attendance.read' },
  {
    to: '/leave',
    label: 'Leave',
    show: (a) => a.can('leave.read') || Boolean(a.me.employee?.isManager),
  },
  {
    to: '/attendance/team',
    label: 'My team',
    show: (a) => Boolean(a.me.employee?.isManager) && !a.can('attendance.read'),
  },
  { to: '/employees', label: 'Employees', permission: 'employees.read' },
  { to: '/holidays', label: 'Holidays', permission: 'holidays.read' },
  { to: '/company-setup', label: 'Company setup', permission: 'org_structure.manage' },
  { to: '/branches', label: 'Branches', permission: 'branches.read' },
  { to: '/users', label: 'Users & roles', permission: 'users.read' },
  { to: '/audit', label: 'Audit log', permission: 'audit.read' },
];

export function AppLayout() {
  const auth = useAuth();
  const { me } = auth;
  // Hiding links is a convenience only; the API enforces every permission.
  const links = NAV.filter(
    (item) => (!item.permission || auth.can(item.permission)) && (!item.show || item.show(auth)),
  );

  return (
    <div className="min-h-screen md:grid md:grid-cols-[230px_1fr]">
      <aside className="border-b border-slate-200 bg-white md:min-h-screen md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-5 py-4">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-brand-900">HealthOS</p>
            <p className="truncate text-xs text-slate-500">{me.organization.name}</p>
          </div>
        </div>
        <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col">
          {links.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-lg px-3 py-2 text-sm ${
                  isActive
                    ? 'bg-brand-50 font-medium text-brand-700'
                    : 'text-slate-600 hover:bg-slate-100'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="min-w-0">
        <header className="flex items-center justify-end gap-3 border-b border-slate-200 bg-white px-6 py-3">
          <span className="hidden rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 sm:inline">
            Pilot build · synthetic data only
          </span>
          <div className="text-right">
            <p className="text-sm font-medium text-slate-800">{me.user.fullName}</p>
            <p className="text-xs text-slate-500">{me.roles.map((r) => r.label).join(', ')}</p>
          </div>
          {/* Employees sign in with OTP and have no password. */}
          {me.user.email && (
            <NavLink to="/account/password" className="text-xs text-slate-500 hover:text-slate-800">
              Password
            </NavLink>
          )}
          <Button variant="secondary" size="sm" onClick={() => auth.logout()}>
            Sign out
          </Button>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
