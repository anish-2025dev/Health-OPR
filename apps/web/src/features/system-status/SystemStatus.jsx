import { useSystemStatus } from './use-system-status';

const LABELS = { api: 'API', postgres: 'PostgreSQL', redis: 'Redis' };

function Dot({ state }) {
  const color =
    state === 'ok' ? 'bg-emerald-500' : state === 'checking' ? 'bg-amber-400' : 'bg-rose-500';
  return <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />;
}

export function SystemStatus() {
  const { data, isPending, isError } = useSystemStatus();

  const rows = isPending
    ? [['api', 'checking']]
    : isError
      ? [['api', 'unavailable']]
      : [['api', 'ok'], ...Object.entries(data.dependencies)];

  return (
    <section
      aria-labelledby="system-status-heading"
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2 id="system-status-heading" className="text-sm font-semibold text-slate-700">
        Development environment status
      </h2>
      <ul className="mt-3 space-y-2">
        {rows.map(([name, state]) => (
          <li key={name} className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <Dot state={state} />
              {LABELS[name] ?? name}
            </span>
            <span className="text-slate-500">{state}</span>
          </li>
        ))}
      </ul>
      {isError && (
        <p className="mt-3 text-xs text-slate-500">
          Start the API with <code>npm run dev:api</code> and services with <code>make up</code>.
        </p>
      )}
    </section>
  );
}
