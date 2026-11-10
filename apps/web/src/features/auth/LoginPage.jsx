import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { Alert, Button, Field, Input } from '@/components/ui';
import { useAuth } from './auth-context';

const schema = z.object({
  email: z.string().trim().email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password'),
});

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({ resolver: zodResolver(schema) });

  if (auth.status === 'authenticated') return <Navigate to="/" replace />;

  const onSubmit = async ({ email, password }) => {
    setError(null);
    try {
      await auth.login(email, password);
      navigate(location.state?.from ?? '/', { replace: true });
    } catch (err) {
      setError(err.message || 'Sign-in failed');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <img src="/favicon.svg" alt="" className="h-12 w-12" />
          <h1 className="text-2xl font-bold text-slate-900">Sign in to HealthOS</h1>
          <p className="text-sm text-slate-500">Staff and administrator access</p>
        </div>
        <form
          onSubmit={handleSubmit(onSubmit)}
          noValidate
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          {error && <Alert>{error}</Alert>}
          <Field label="Email" htmlFor="email" error={errors.email?.message}>
            <Input id="email" type="email" autoComplete="username" {...register('email')} />
          </Field>
          <Field label="Password" htmlFor="password" error={errors.password?.message}>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              {...register('password')}
            />
          </Field>
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
        <p className="mt-6 text-center text-xs text-slate-500">
          Forgot your password? Ask your organization admin to reset it.
        </p>
        <p className="mt-2 text-center text-sm">
          <Link to="/employee-login" className="font-medium text-brand-700 hover:underline">
            Employee? Sign in with your mobile number
          </Link>
        </p>
      </div>
    </div>
  );
}
