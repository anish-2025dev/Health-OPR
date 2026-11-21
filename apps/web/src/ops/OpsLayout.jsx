import { NavLink, Outlet } from 'react-router';
import { useAuth } from '@/features/auth/auth-context';
import { Button } from '@/components/ui';

const OPS_NAV = [
  {
    to: '/',
    label: 'Clinic overview',
    end: true,
    show: (a) => a.can('appointments.read') || a.can('queue.manage'),
  },
  { to: '/clinic', label: 'Clinic today', permission: 'appointments.read' },
  {
    to: '/reception',
    label: 'Reception & queue',
    permission: 'queue.manage',
    show: (a) => a.can('appointments.manage'),
  },
  {
    to: '/reception',
    label: 'My queue',
    permission: 'queue.manage',
    show: (a) => !a.can('appointments.manage'),
  },
  { to: '/patients', label: 'Patients', permission: 'patients.read' },
  { to: '/doctors', label: 'Doctors', permission: 'appointments.read' },
  { to: '/privacy', label: 'Patient privacy', permission: 'patients.manage' },
  { to: '/messaging', label: 'WhatsApp & SMS', permission: 'organization.manage' },
  { to: '/analytics', label: 'Clinic analytics', permission: 'appointments.read' },
  { to: '/branches', label: 'Branches', permission: 'branches.read' },
  { to: '/users', label: 'Users & roles', permission: 'users.read' },
  { to: '/audit', label: 'Audit log', permission: 'audit.read' },
];

export function OpsLayout() {
  const auth = useAuth();
  const { me } = auth;

  const links = OPS_NAV.filter(
    (item) => (!item.permission || auth.can(item.permission)) && (!item.show || item.show(auth)),
  );

  return (
    <div className="min-h-screen md:grid md:grid-cols-[240px_1fr]">
      <aside className="border-b border-slate-200 bg-white md:min-h-screen md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-5 py-4">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-bold text-teal-900">Suntek-ops</span>
              <span className="rounded bg-teal-50 px-1 py-0.5 text-[10px] font-semibold text-teal-700">
                Clinic
              </span>
            </div>
            <p className="truncate text-xs text-slate-500">{me.organization.name}</p>
          </div>
        </div>
        <nav
          aria-label="Clinical Operations"
          className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col"
        >
          {links.map((item) => (
            <NavLink
              key={`${item.to}-${item.label}`}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-lg px-3 py-2 text-sm ${
                  isActive
                    ? 'bg-teal-50 font-medium text-teal-800'
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
          <span className="hidden rounded-full bg-teal-100 px-2.5 py-0.5 text-xs font-medium text-teal-800 sm:inline">
            Suntek-ops · Hospital Operations
          </span>
          <div className="text-right">
            <p className="text-sm font-medium text-slate-800">{me.user.fullName}</p>
            <p className="text-xs text-slate-500">{me.roles.map((r) => r.label).join(', ')}</p>
          </div>
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
