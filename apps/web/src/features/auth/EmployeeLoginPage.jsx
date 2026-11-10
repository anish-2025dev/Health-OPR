import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { Alert, Button, Field, Input } from '@/components/ui';
import { useAuth } from './auth-context';

const COMPANY_KEY = 'healthos.companyCode';

// Remembering the company code is a convenience only; storage can be unavailable (private mode).
const readCompany = () => {
  try {
    return localStorage.getItem(COMPANY_KEY) ?? '';
  } catch {
    return '';
  }
};
const saveCompany = (value) => {
  try {
    localStorage.setItem(COMPANY_KEY, value);
  } catch {
    /* ignore */
  }
};

export function EmployeeLoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [company, setCompany] = useState(params.get('company') ?? readCompany());
  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('mobile');
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);

  if (auth.status === 'authenticated') return <Navigate to="/" replace />;

  const sendCode = async (e) => {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await auth.requestEmployeeOtp(company.trim().toLowerCase(), mobile);
      saveCompany(company.trim().toLowerCase());
      setInfo(res.message);
      setStep('code');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await auth.loginWithOtp(company.trim().toLowerCase(), mobile, code.trim());
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <img src="/favicon.svg" alt="" className="h-12 w-12" />
          <h1 className="text-2xl font-bold text-slate-900">Employee sign-in</h1>
          <p className="text-sm text-slate-500">
            Use the mobile number registered with your employer
          </p>
        </div>
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {error && <Alert>{error}</Alert>}
          {step === 'mobile' ? (
            <form onSubmit={sendCode} className="space-y-4" noValidate>
              <Field label="Company code" htmlFor="company" hint="Ask HR if you don't know it">
                <Input
                  id="company"
                  autoCapitalize="none"
                  autoComplete="organization"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                />
              </Field>
              <Field label="Mobile number" htmlFor="mobile">
                <Input
                  id="mobile"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="98765 43210"
                  value={mobile}
                  onChange={(e) => setMobile(e.target.value)}
                />
              </Field>
              <Button
                type="submit"
                className="w-full"
                disabled={busy || !company.trim() || mobile.trim().length < 10}
              >
                {busy ? 'Sending…' : 'Send code'}
              </Button>
            </form>
          ) : (
            <form onSubmit={verify} className="space-y-4" noValidate>
              {info && <Alert tone="green">{info}</Alert>}
              <Field label="6-digit code" htmlFor="code">
                <Input
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                />
              </Field>
              <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
                {busy ? 'Checking…' : 'Sign in'}
              </Button>
              <div className="flex justify-between text-xs">
                <button
                  type="button"
                  className="text-slate-600 hover:underline"
                  onClick={() => setStep('mobile')}
                >
                  Change number
                </button>
                <button
                  type="button"
                  className="text-slate-600 hover:underline"
                  onClick={sendCode}
                  disabled={busy}
                >
                  Resend code
                </button>
              </div>
            </form>
          )}
        </div>
        <p className="mt-6 text-center text-xs text-slate-500">
          Staff with an email login?{' '}
          <Link to="/login" className="text-brand-700 hover:underline">
            Sign in with email
          </Link>
        </p>
      </div>
    </div>
  );
}
