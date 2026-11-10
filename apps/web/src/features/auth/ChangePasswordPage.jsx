import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from 'react-router';
import { apiFetch } from '@/lib/api-client';
import { Alert, Button, Card, Field, Input } from '@/components/ui';
import { useAuth } from './auth-context';

const schema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z
      .string()
      .min(12, 'Use at least 12 characters')
      .max(128, 'Use at most 128 characters'),
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

/** Used both for the forced first-login change and from the account menu. */
export function ChangePasswordPage({ forced = false }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm({ resolver: zodResolver(schema) });

  const onSubmit = async ({ currentPassword, newPassword }) => {
    setError(null);
    try {
      await apiFetch('/auth/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
      reset();
      await auth.refreshMe();
      if (forced) navigate('/', { replace: true });
      else setDone(true);
    } catch (err) {
      setError(err.message);
    }
  };

  const form = (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
      {error && <Alert>{error}</Alert>}
      {done && <Alert tone="green">Password changed. Other devices have been signed out.</Alert>}
      <Field
        label="Current password"
        htmlFor="currentPassword"
        error={errors.currentPassword?.message}
      >
        <Input
          id="currentPassword"
          type="password"
          autoComplete="current-password"
          {...register('currentPassword')}
        />
      </Field>
      <Field
        label="New password"
        htmlFor="newPassword"
        hint="At least 12 characters. A short phrase is easy to remember."
        error={errors.newPassword?.message}
      >
        <Input
          id="newPassword"
          type="password"
          autoComplete="new-password"
          {...register('newPassword')}
        />
      </Field>
      <Field
        label="Confirm new password"
        htmlFor="confirmPassword"
        error={errors.confirmPassword?.message}
      >
        <Input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          {...register('confirmPassword')}
        />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Change password'}
        </Button>
        {forced && (
          <Button variant="ghost" onClick={() => auth.logout()}>
            Sign out
          </Button>
        )}
      </div>
    </form>
  );

  if (!forced) {
    return (
      <div className="max-w-md">
        <Card title="Change password">{form}</Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <h1 className="mb-2 text-xl font-bold text-slate-900">Set your own password</h1>
        <p className="mb-6 text-sm text-slate-600">
          You signed in with a temporary password. Choose a new one to continue.
        </p>
        <Card>{form}</Card>
      </div>
    </div>
  );
}
