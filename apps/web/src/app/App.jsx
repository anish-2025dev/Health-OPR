import { SystemStatus } from '@/features/system-status/SystemStatus';

const MODULES = [
  'Patient registration',
  'Appointments & queue',
  'WhatsApp self-service',
  'Employees & attendance',
  'Leave & shifts',
  'Payroll',
];

export function App() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-4">
          <img src="/favicon.svg" alt="" className="h-8 w-8" />
          <span className="text-lg font-semibold text-brand-900">HealthOS</span>
          <span className="ml-auto rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
            Development build · synthetic data only
          </span>
        </div>
      </header>

      <main className="mx-auto grid max-w-5xl gap-6 px-4 py-10 md:grid-cols-[2fr_1fr]">
        <section>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            Healthcare Operations OS
          </h1>
          <p className="mt-3 max-w-prose text-slate-600">
            Operations software for hospitals, clinics and nursing homes, covering patient flow,
            queues and the workforce. The foundation is in place; modules arrive phase by phase.
          </p>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2">
            {MODULES.map((name) => (
              <li
                key={name}
                className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-3 text-sm text-slate-500"
              >
                {name} <span className="text-xs">· planned</span>
              </li>
            ))}
          </ul>
        </section>
        <aside>
          <SystemStatus />
        </aside>
      </main>
    </div>
  );
}
