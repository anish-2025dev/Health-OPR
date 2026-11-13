import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router';
import {
  Alert,
  Badge,
  Button,
  Card,
  ErrorMessage,
  Field,
  Input,
  PageHeader,
  Spinner,
} from '@/components/ui';
import {
  platformFetch,
  refreshPlatformSession,
  setPlatformAuthLost,
  setPlatformToken,
} from './platform-api';

/**
 * Platform console for the operator's own team: onboard hospitals, send owner sign-in links, suspend or
 * reactivate. Shows counts only, never patient or employee records.
 */
const Ctx = createContext(null);
const usePlatform = () => useContext(Ctx);

function Provider({ children }) {
  const qc = useQueryClient();
  const [state, setState] = useState({ status: 'loading', me: null });
  const lost = useCallback(() => {
    setPlatformToken(null);
    qc.removeQueries({ queryKey: ['platform'] });
    setState({ status: 'anonymous', me: null });
  }, [qc]);
  const loadMe = useCallback(async () => {
    const me = await platformFetch('/me');
    setState({ status: 'authenticated', me });
  }, []);
  useEffect(() => {
    setPlatformAuthLost(lost);
    refreshPlatformSession().then((ok) => (ok ? loadMe().catch(lost) : lost()));
  }, [lost, loadMe]);
  const value = useMemo(
    () => ({
      ...state,
      async signIn(email, password) {
        const r = await platformFetch('/auth/login', {
          method: 'POST',
          body: { email, password },
          auth: false,
        });
        setPlatformToken(r.accessToken);
        await loadMe();
      },
      async signOut() {
        await platformFetch('/auth/logout', { method: 'POST', auth: false }).catch(() => {});
        lost();
      },
      reload: loadMe,
    }),
    [state, lost, loadMe],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function Shell({ children }) {
  const p = usePlatform();
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-brand-900 text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <Link to="/platform" className="flex items-center gap-2">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            <span className="text-sm font-semibold">HealthOS · Platform console</span>
          </Link>
          {p.status === 'authenticated' && (
            <div className="flex items-center gap-3 text-sm">
              <span className="hidden text-brand-50/80 sm:inline">{p.me.fullName}</span>
              <Button size="sm" variant="secondary" onClick={() => p.signOut()}>
                Sign out
              </Button>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}

function SignIn() {
  const p = usePlatform();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto max-w-sm">
      <Card title="Platform console sign-in">
        <p className="mb-3 text-sm text-slate-600">
          For the HealthOS operations team only. Hospital staff sign in on the main login page.
        </p>
        <ErrorMessage error={error} />
        <form
          className="mt-2 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await p.signIn(email, password);
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Email" htmlFor="pe">
            <Input
              id="pe"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password" htmlFor="pp">
            <Input
              id="pp"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" className="w-full" disabled={busy}>
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}

function ChangePassword() {
  const p = usePlatform();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '' });
  const save = useMutation({
    mutationFn: () => platformFetch('/me/password', { method: 'POST', body: form }),
    onSuccess: () => p.reload(),
  });
  return (
    <div className="mx-auto max-w-sm">
      <Card title="Set your own password">
        <p className="mb-3 text-sm text-slate-600">
          Replace the temporary password before continuing (at least 12 characters).
        </p>
        <ErrorMessage error={save.error} />
        <form
          className="mt-2 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Temporary password" htmlFor="cp">
            <Input
              id="cp"
              type="password"
              required
              value={form.currentPassword}
              onChange={(e) => setForm({ ...form, currentPassword: e.target.value })}
            />
          </Field>
          <Field label="New password" htmlFor="np">
            <Input
              id="np"
              type="password"
              minLength={12}
              required
              value={form.newPassword}
              onChange={(e) => setForm({ ...form, newPassword: e.target.value })}
            />
          </Field>
          <Button type="submit" className="w-full" disabled={save.isPending}>
            Save password
          </Button>
        </form>
      </Card>
    </div>
  );
}

const STATUS_TONE = { active: 'green', suspended: 'red', closed: 'slate' };
const fmt = (iso) =>
  iso
    ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';

function CopyLink({ url, expiresAt }) {
  const [copied, setCopied] = useState(false);
  return (
    <Alert tone="green">
      <p className="font-medium">
        One-time sign-in link for the owner (valid until {fmt(expiresAt)})
      </p>
      <p className="mt-1 font-mono text-xs break-all">{url}</p>
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            navigator.clipboard?.writeText(url);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </Button>
        <a
          className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700"
          href={`https://wa.me/?text=${encodeURIComponent(`Your HealthOS account is ready. Set your password here (link works once): ${url}`)}`}
          target="_blank"
          rel="noreferrer"
        >
          Share on WhatsApp
        </a>
      </div>
      <p className="mt-2 text-xs">
        Send it only to the owner. It works once; you can create a new one any time.
      </p>
    </Alert>
  );
}

function Hospitals() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const list = useQuery({
    queryKey: ['platform', 'orgs'],
    queryFn: () => platformFetch('/organizations'),
  });
  const [form, setForm] = useState(null);
  const [created, setCreated] = useState(null);
  const create = useMutation({
    mutationFn: (body) => platformFetch('/organizations', { method: 'POST', body }),
    onSuccess: (r) => {
      setCreated(r);
      setForm(null);
      qc.invalidateQueries({ queryKey: ['platform', 'orgs'] });
    },
  });
  const set = (k) => (e) => {
    const v = e.target.value;
    setForm((f) => ({
      ...f,
      [k]: v,
      ...(k === 'name' && !f.codeTouched
        ? {
            code: v
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '')
              .slice(0, 50),
          }
        : {}),
      ...(k === 'code' ? { codeTouched: true } : {}),
    }));
  };
  const rows = list.data?.data ?? [];
  return (
    <>
      <PageHeader
        title="Hospitals"
        description="Every client organization on the platform. Each one's data is separate; this console shows counts only."
        actions={
          !form && (
            <Button
              onClick={() => (
                setCreated(null),
                setForm({ name: '', code: '', ownerName: '', ownerEmail: '', branchName: 'Main' })
              )}
            >
              Onboard a hospital
            </Button>
          )
        }
      />
      {created && (
        <div className="mb-6 space-y-2">
          <Alert tone="green">
            <strong>{created.name}</strong> created with hospital code{' '}
            <strong>{created.code}</strong>.{' '}
            <button
              type="button"
              className="underline"
              onClick={() => navigate(`/platform/hospitals/${created.id}`)}
            >
              Open
            </button>
          </Alert>
          <CopyLink url={created.invite.url} expiresAt={created.invite.expiresAt} />
        </div>
      )}
      {form && (
        <Card title="Onboard a hospital" className="mb-6">
          <ErrorMessage error={create.error} />
          <form
            className="mt-2 grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              const { name, code, ownerName, ownerEmail, branchName } = form;
              create.mutate({ name, code, ownerName, ownerEmail, branchName });
            }}
          >
            <Field label="Hospital name" htmlFor="hn">
              <Input id="hn" required value={form.name} onChange={set('name')} />
            </Field>
            <Field
              label="Hospital code"
              htmlFor="hc"
              hint="Patients and employees type this; also in the QR link. Lowercase, digits, dashes."
            >
              <Input
                id="hc"
                required
                pattern="[a-z0-9][a-z0-9\-]{1,48}[a-z0-9]"
                value={form.code}
                onChange={set('code')}
              />
            </Field>
            <Field label="Owner's full name" htmlFor="on">
              <Input id="on" required value={form.ownerName} onChange={set('ownerName')} />
            </Field>
            <Field label="Owner's email (their login)" htmlFor="oe">
              <Input
                id="oe"
                type="email"
                required
                value={form.ownerEmail}
                onChange={set('ownerEmail')}
              />
            </Field>
            <Field label="First branch name" htmlFor="bn">
              <Input id="bn" required value={form.branchName} onChange={set('branchName')} />
            </Field>
            <div className="flex items-end gap-2">
              <Button type="submit" disabled={create.isPending}>
                Create hospital
              </Button>
              <Button variant="ghost" onClick={() => setForm(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
      <Card>
        {list.isPending && <Spinner />}
        <ErrorMessage error={list.error} />
        {rows.length === 0 && list.data && (
          <p className="text-sm text-slate-500">No hospitals yet.</p>
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500 uppercase">
                <tr>
                  <th className="py-2 pr-4">Hospital</th>
                  <th className="py-2 pr-4">Owner</th>
                  <th className="py-2 pr-4">Branches</th>
                  <th className="py-2 pr-4">Staff</th>
                  <th className="py-2 pr-4">Employees</th>
                  <th className="py-2 pr-4">Patients</th>
                  <th className="py-2 pr-4">Since</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((o) => (
                  <tr key={o.id}>
                    <td className="py-2 pr-4">
                      <Link
                        to={`/platform/hospitals/${o.id}`}
                        className="font-medium text-brand-700"
                      >
                        {o.name}
                      </Link>
                      <span className="block font-mono text-xs text-slate-500">{o.code}</span>
                    </td>
                    <td className="py-2 pr-4">
                      {o.owners.map((w) => (
                        <span key={w.id} className="block">
                          {w.fullName}
                          {!w.activated && (
                            <span className="ml-1 text-xs text-amber-700">(link not used yet)</span>
                          )}
                        </span>
                      ))}
                    </td>
                    <td className="py-2 pr-4">{o.counts.branches}</td>
                    <td className="py-2 pr-4">{o.counts.staff}</td>
                    <td className="py-2 pr-4">{o.counts.employees}</td>
                    <td className="py-2 pr-4">{o.counts.patients}</td>
                    <td className="py-2 pr-4">{fmt(o.createdAt)}</td>
                    <td className="py-2">
                      <Badge tone={STATUS_TONE[o.status]}>{o.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function Hospital() {
  const { id } = useParams();
  const qc = useQueryClient();
  const org = useQuery({
    queryKey: ['platform', 'org', id],
    queryFn: () => platformFetch(`/organizations/${id}`),
  });
  const [link, setLink] = useState(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['platform', 'org', id] });
    qc.invalidateQueries({ queryKey: ['platform', 'orgs'] });
  };
  const invite = useMutation({
    mutationFn: (userId) =>
      platformFetch(`/organizations/${id}/invites`, { method: 'POST', body: { userId } }),
    onSuccess: (r) => (setLink(r), refresh()),
  });
  const status = useMutation({
    mutationFn: ({ action, reason }) =>
      platformFetch(`/organizations/${id}/${action}`, { method: 'POST', body: { reason } }),
    onSuccess: refresh,
  });
  if (org.isPending) return <Spinner />;
  if (org.error) return <ErrorMessage error={org.error} />;
  const o = org.data;
  const ask = (action) => {
    const reason = window.prompt(
      action === 'suspend'
        ? 'Why is this hospital being suspended? Everyone will be signed out.'
        : 'Reason for reactivating',
    );
    if (reason) status.mutate({ action, reason });
  };
  return (
    <>
      <Link to="/platform" className="text-sm text-brand-700">
        ← All hospitals
      </Link>
      <PageHeader
        title={o.name}
        description={`Hospital code: ${o.code} · on HealthOS since ${fmt(o.createdAt)}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={STATUS_TONE[o.status]}>{o.status}</Badge>
            {o.status === 'active' ? (
              <Button variant="danger" onClick={() => ask('suspend')}>
                Suspend
              </Button>
            ) : (
              <Button onClick={() => ask('reactivate')}>Reactivate</Button>
            )}
          </div>
        }
      />
      <ErrorMessage error={invite.error || status.error} />
      {link && (
        <div className="mb-4">
          <CopyLink url={link.url} expiresAt={link.expiresAt} />
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Usage">
          <dl className="grid grid-cols-2 gap-4">
            {Object.entries(o.counts).map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-slate-500 capitalize">{k}</dt>
                <dd className="text-2xl font-semibold">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card title="Owners">
          <ul className="space-y-3 text-sm">
            {o.owners.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium">{w.fullName}</span>
                  <span className="block text-xs text-slate-500">
                    {w.email} ·{' '}
                    {w.activated
                      ? `last sign-in ${fmt(w.lastLoginAt)}`
                      : 'has not used the sign-in link yet'}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => invite.mutate(w.id)}
                  disabled={invite.isPending || o.status !== 'active'}
                >
                  New sign-in link
                </Button>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-slate-500">
            A new link also helps an owner who forgot their password. Owners add their own admins
            and staff inside the hospital.
          </p>
        </Card>
        <Card title="History" className="lg:col-span-2">
          <ul className="divide-y divide-slate-100 text-sm">
            {o.history.map((h) => (
              <li key={`${h.action}-${h.at}`} className="py-2">
                {new Date(h.at).toLocaleString('en-IN')} ·{' '}
                {h.action.replace('platform.', '').replace(/_/g, ' ')}
                {h.by ? ` by ${h.by}` : ''}
                {h.reason ? ` — ${h.reason}` : ''}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

function Gate({ children }) {
  const p = usePlatform();
  if (p.status === 'loading') return <Spinner />;
  if (p.status === 'anonymous') return <SignIn />;
  if (p.me.mustChangePassword) return <ChangePassword />;
  return children;
}

export function PlatformApp() {
  return (
    <Provider>
      <Shell>
        <Gate>
          <Routes>
            <Route index element={<Hospitals />} />
            <Route path="hospitals/:id" element={<Hospital />} />
            <Route path="*" element={<Navigate to="/platform" replace />} />
          </Routes>
        </Gate>
      </Shell>
    </Provider>
  );
}
