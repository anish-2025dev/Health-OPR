/* Small set of shared UI primitives (Tailwind). Replace with shadcn/ui components as the app grows. */

const cx = (...classes) => classes.filter(Boolean).join(' ');

export function Button({ variant = 'primary', size = 'md', className, ...props }) {
  const variants = {
    primary: 'bg-brand-700 text-white hover:bg-brand-900 disabled:bg-slate-300',
    secondary:
      'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400',
    danger: 'bg-white text-rose-700 border border-rose-200 hover:bg-rose-50',
    ghost: 'text-slate-600 hover:bg-slate-100',
  };
  const sizes = { sm: 'px-2.5 py-1 text-xs', md: 'px-4 py-2 text-sm' };
  return (
    <button
      type="button"
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}

export function Field({ label, error, hint, htmlFor, children }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-slate-500">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs text-rose-600">
          {error}
        </p>
      )}
    </div>
  );
}

const inputClass =
  'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600';

/** A width passed in `className` (e.g. "w-44") replaces the default full width. */
const fieldClass = (className) =>
  cx(/(^|\s)w-/.test(className ?? '') ? inputClass.replace('w-full ', '') : inputClass, className);

export const Input = ({ className, ...props }) => (
  <input className={fieldClass(className)} {...props} />
);

export const Select = ({ className, ...props }) => (
  <select className={fieldClass(className)} {...props} />
);

export function Card({ title, actions, children, className }) {
  return (
    <section className={cx('rounded-xl border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
          {title && <h2 className="text-sm font-semibold text-slate-800">{title}</h2>}
          {actions}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Badge({ tone = 'slate', children }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700',
    green: 'bg-emerald-50 text-emerald-700',
    red: 'bg-rose-50 text-rose-700',
    amber: 'bg-amber-50 text-amber-800',
    brand: 'bg-brand-50 text-brand-700',
  };
  return (
    <span className={cx('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', tones[tone])}>
      {children}
    </span>
  );
}

export function Alert({ tone = 'red', children }) {
  const tones = {
    red: 'border-rose-200 bg-rose-50 text-rose-800',
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  };
  return (
    <div
      role={tone === 'red' ? 'alert' : 'status'}
      className={cx('rounded-lg border px-4 py-3 text-sm', tones[tone])}
    >
      {children}
    </div>
  );
}

export function PageHeader({ title, description, actions }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-600">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div role="status" className="flex items-center gap-2 text-sm text-slate-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
      {label}
    </div>
  );
}

/** Shows an ApiError (or any error) as a readable message. */
export function ErrorMessage({ error }) {
  if (!error) return null;
  return <Alert>{error.message || 'Something went wrong'}</Alert>;
}
