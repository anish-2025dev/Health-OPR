/** Shown only on the demo deployment, for the demo hospital's fictional numbers. */
export function DemoCode({ code }) {
  if (!code) return null;
  return (
    <div
      role="status"
      className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      Demo mode, so no SMS is sent. Your code is{' '}
      <span className="font-mono text-base font-bold tracking-widest">{code}</span>
    </div>
  );
}
