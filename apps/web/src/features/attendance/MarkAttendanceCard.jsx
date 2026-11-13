import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { Alert, Button, Card, Field, Input, Spinner } from '@/components/ui';
import { DemoCode } from '@/components/DemoCode';
import { StatusBadge } from './MonthView';

/** Reads the phone's location in high-accuracy mode. */
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(
        new Error(
          'This browser cannot share its location. Use the phone browser (Chrome or Safari).',
        ),
      );
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
      (err) =>
        reject(
          new Error(
            err.code === 1
              ? 'Location permission is blocked. Allow location for this site in your browser settings, then try again.'
              : 'Could not get your location. Make sure location is on and try again.',
          ),
        ),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  });
}

/**
 * "Mark attendance": 1) read location, 2) server checks the geofence and sends an OTP,
 * 3) employee enters the OTP, 4) punch recorded. Nothing is marked unless both checks pass.
 */
export function MarkAttendanceCard() {
  const queryClient = useQueryClient();
  const today = useQuery({
    queryKey: ['me', 'today'],
    queryFn: () => apiFetch('/me/attendance/today'),
  });
  const [step, setStep] = useState('idle'); // idle | locating | otp | done
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const start = useMutation({
    mutationFn: async () => {
      setStep('locating');
      const position = await getPosition();
      return apiFetch('/me/attendance/start', { method: 'POST', body: position });
    },
    onSuccess: (data) => {
      setChallenge(data);
      setCode('');
      setStep('otp');
    },
    onError: (err) => {
      setStep('idle');
      const d = err.details;
      const extra =
        d && d.distanceM !== null && d.distanceM !== undefined
          ? ` (you are about ${Math.round(d.distanceM)} m away; allowed ${d.radiusM} m${d.accuracyM ? `, location accuracy ±${Math.round(d.accuracyM)} m` : ''})`
          : d?.accuracyM
            ? ` (location accuracy ±${Math.round(d.accuracyM)} m; needs ${d.radiusM} m or better)`
            : '';
      setError(`${err.message}${extra}`);
    },
  });

  const confirm = useMutation({
    mutationFn: () =>
      apiFetch('/me/attendance/confirm', {
        method: 'POST',
        body: { challengeId: challenge.challengeId, code },
      }),
    onSuccess: (data) => {
      setDone(data);
      setStep('done');
      queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err) => setError(err.message),
  });

  if (today.isPending)
    return (
      <Card>
        <Spinner />
      </Card>
    );
  if (today.error) return <Alert>{today.error.message}</Alert>;
  const t = today.data;
  const action = t.nextAction === 'check_out' ? 'Check out' : 'Check in';

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-slate-500">
            {t.branch.name}
            {t.shift && ` · ${t.shift.name} ${t.shift.start}–${t.shift.end}`}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <p className="text-lg font-semibold text-slate-900">Today</p>
            {t.today ? (
              <StatusBadge status={t.today.status} />
            ) : (
              <StatusBadge status="not_checked_in" />
            )}
          </div>
          {t.today && (
            <p className="mt-1 text-sm text-slate-600">
              In <span className="font-mono">{t.today.checkIn ?? '—'}</span> · Out{' '}
              <span className="font-mono">{t.today.checkOut ?? '—'}</span>
              {t.today.isLate && (
                <span className="text-amber-700"> · {t.today.lateMinutes} min late</span>
              )}
            </p>
          )}
        </div>
        {step !== 'otp' && (
          <Button
            className="min-w-40 py-3 text-base"
            disabled={start.isPending || !t.branch.locationConfigured || !t.smsAvailable}
            onClick={() => {
              setError(null);
              setDone(null);
              start.mutate();
            }}
          >
            {step === 'locating' ? 'Checking location…' : `${action}`}
          </Button>
        )}
      </div>

      <div className="mt-4 space-y-3">
        {!t.branch.locationConfigured && (
          <Alert tone="amber">
            Your branch&apos;s attendance location isn&apos;t set yet. Ask your administrator.
          </Alert>
        )}
        {!t.smsAvailable && (
          <Alert tone="amber">SMS isn&apos;t set up yet, so attendance can&apos;t be marked.</Alert>
        )}
        {error && <Alert>{error}</Alert>}
        {step === 'done' && done && (
          <Alert tone="green">
            {done.punchType === 'in' ? 'Checked in' : 'Checked out'} at{' '}
            {done.punchType === 'in' ? done.day.checkIn : done.day.checkOut}.
          </Alert>
        )}
        {step === 'otp' && challenge && <DemoCode code={challenge.demoCode} />}
        {step === 'otp' && challenge && (
          <form
            className="space-y-3 rounded-lg border border-brand-600/30 bg-brand-50 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              confirm.mutate();
            }}
          >
            <p className="text-sm text-slate-700">
              Location verified ({Math.round(challenge.distanceM)} m from the branch). Enter the
              code sent to <span className="font-mono">{challenge.sentTo}</span> to{' '}
              {action.toLowerCase()}.
            </p>
            <Field label="6-digit code" htmlFor="att-code">
              <Input
                id="att-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" disabled={confirm.isPending || code.length !== 6}>
                {confirm.isPending ? 'Confirming…' : `Confirm ${action.toLowerCase()}`}
              </Button>
              <Button variant="ghost" onClick={() => setStep('idle')}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}
