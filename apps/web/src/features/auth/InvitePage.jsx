import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { apiFetch } from '@/lib/api-client';
import { Alert, Button, ErrorMessage, Field, Input, Spinner } from '@/components/ui';

/** One-time link: a new owner (or user) sets their password and is signed in. */
export function InvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const info = useQuery({
    queryKey: ['invite', token],
    queryFn: () => apiFetch(`/auth/invite/${encodeURIComponent(token)}`, { auth: false }),
    enabled: token.length > 0,
    retry: false,
  });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== password;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-center">
          <img src="/favicon.svg" alt="" className="mx-auto h-10 w-10" />
          <h1 className="mt-2 text-xl font-bold text-slate-900">Set your password</h1>
        </div>
        {!token && <Alert>This link is incomplete. Ask for a new link.</Alert>}
        {info.isPending && token && <Spinner />}
        {info.error && (
          <>
            <ErrorMessage error={info.error} />
            <Link to="/login" className="block text-center text-sm text-brand-700">
              Go to sign in
            </Link>
          </>
        )}
        {info.data && (
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (mismatch) return;
              setBusy(true);
              setError(null);
              try {
                await apiFetch('/auth/invite/accept', {
                  method: 'POST',
                  body: { token, password },
                  auth: false,
                });
                // The sign-in cookie is now set; the app picks it up on load.
                window.location.replace('/');
              } catch (err) {
                setError(err);
                setBusy(false);
              }
            }}
          >
            <p className="text-sm text-slate-600">
              Welcome to <strong>{info.data.organizationName}</strong> on HealthOS,{' '}
              {info.data.fullName}. You will sign in with <strong>{info.data.email}</strong>.
            </p>
            <ErrorMessage error={error} />
            <Field
              label="New password"
              htmlFor="ip"
              hint="At least 12 characters. A short sentence is easy to remember."
            >
              <Input
                id="ip"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field
              label="Repeat password"
              htmlFor="ic"
              error={mismatch ? 'Passwords do not match' : null}
            >
              <Input
                id="ic"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>
            <Button type="submit" className="w-full" disabled={busy || mismatch}>
              Save and sign in
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
