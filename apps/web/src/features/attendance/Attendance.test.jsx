import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/features/auth/auth-context';
import { tokenStore } from '@/lib/api-client';
import { App } from '@/app/App';

const json = (status, body) => ({
  ok: status < 400,
  status,
  statusText: 'x',
  json: async () => body,
});

const EMPLOYEE_ME = {
  user: { id: 'u9', email: null, fullName: 'Wasim Worker', mustChangePassword: false },
  organization: { id: 'o1', name: 'Sunrise Clinic', slug: 'sunrise', timezone: 'Asia/Kolkata' },
  roles: [{ role: 'employee', label: 'Employee', branchId: null }],
  permissions: ['holidays.read'],
  branchIds: null,
  employee: {
    id: 'e2',
    employeeNumber: 'EMP-0002',
    fullName: 'Wasim Worker',
    branchId: 'b1',
    status: 'active',
    isManager: false,
  },
};

const TODAY = {
  employee: { id: 'e2', employeeNumber: 'EMP-0002', fullName: 'Wasim Worker' },
  branch: { name: 'Main', locationConfigured: true, radiusM: 10 },
  shift: { name: 'General', start: '09:00', end: '18:00', breakMinutes: 60 },
  nextAction: 'check_in',
  workDate: '2026-11-10',
  today: null,
  smsAvailable: true,
};

const MONTH = {
  month: '2026-11',
  employee: {
    id: 'e2',
    employeeNumber: 'EMP-0002',
    fullName: 'Wasim Worker',
    branch: { id: 'b1', name: 'Main' },
    shift: null,
  },
  days: [
    {
      date: '2026-11-09',
      status: 'present',
      statusSource: 'computed',
      checkIn: '09:30',
      checkOut: '18:40',
      workedMinutes: 550,
      lateMinutes: 30,
      isLate: true,
      overtimeMinutes: 0,
      isHoliday: false,
      isWeekOff: false,
      dayOfWeek: 1,
      holidayName: null,
      pendingRegularization: false,
    },
  ],
  summary: {
    present: 1,
    halfDay: 0,
    reducedHours: 0,
    absent: 0,
    incomplete: 0,
    leave: 0,
    weekOff: 0,
    holiday: 0,
    late: 1,
    workedMinutes: 550,
    overtimeMinutes: 0,
  },
  lateEntries: [{ date: '2026-11-09', checkIn: '09:30', lateMinutes: 30 }],
  latePenalty: {
    lateCount: 1,
    freeAllowed: 0,
    penalizedLates: 1,
    mode: 'fixed_amount',
    amount: '50.00',
  },
  holidays: [],
  policy: { lateGraceMinutes: 15, lateFreePerMonth: 0 },
};

function mockApi(routes) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init = {}) => {
    const path = String(url)
      .replace(/^.*\/api\/v1/, '')
      .split('?')[0];
    const handler = routes[`${init.method ?? 'GET'} ${path}`];
    if (!handler) return json(404, { error: { code: 'NOT_MOCKED', message: path } });
    return typeof handler === 'function' ? handler(init) : handler;
  });
}

function mockGeolocation(coords) {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition: (ok) => ok({ coords }) },
  });
}

function renderAt(path) {
  tokenStore.clear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  delete navigator.geolocation;
});

describe('employee sign-in', () => {
  it('signs in with company code, mobile and OTP, then lands on My attendance', async () => {
    let signedIn = false;
    const calls = [];
    mockApi({
      'POST /auth/refresh': () => json(401, { error: { code: 'INVALID_SESSION', message: 'no' } }),
      'POST /auth/employee/request-otp': (init) => {
        calls.push(JSON.parse(init.body));
        return json(202, {
          message:
            'If this mobile number is registered with this company, a 6-digit code has been sent by SMS.',
        });
      },
      'POST /auth/employee/verify-otp': (init) => {
        calls.push(JSON.parse(init.body));
        signedIn = true;
        return json(200, { accessToken: 'emp-token', expiresIn: 900 });
      },
      'GET /auth/me': () =>
        signedIn ? json(200, EMPLOYEE_ME) : json(401, { error: { code: 'X', message: 'x' } }),
      'GET /me/attendance/today': json(200, TODAY),
      'GET /me/attendance': json(200, MONTH),
      'GET /me/attendance/regularizations': json(200, { data: [] }),
    });
    renderAt('/employee-login?company=sunrise');
    const user = userEvent.setup();
    expect(await screen.findByLabelText('Company code')).toHaveValue('sunrise');
    await user.type(screen.getByLabelText('Mobile number'), '9100000002');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'My attendance' })).toBeInTheDocument();
    expect(calls).toEqual([
      { company: 'sunrise', mobile: '9100000002' },
      { company: 'sunrise', mobile: '9100000002', code: '123456' },
    ]);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav).toHaveTextContent('My attendance');
    expect(nav).not.toHaveTextContent('Dashboard');
    expect(await screen.findByText(/₹50.00 late penalty/)).toBeInTheDocument();
  });
});

describe('mark attendance', () => {
  const signedInRoutes = (extra) => ({
    'POST /auth/refresh': json(200, { accessToken: 't', expiresIn: 900 }),
    'GET /auth/me': json(200, EMPLOYEE_ME),
    'GET /me/attendance/today': json(200, TODAY),
    'GET /me/attendance': json(200, MONTH),
    'GET /me/attendance/regularizations': json(200, { data: [] }),
    ...extra,
  });

  it('sends the location, then confirms with the OTP', async () => {
    mockGeolocation({ latitude: 12.97163, longitude: 77.5946, accuracy: 6 });
    const bodies = {};
    mockApi(
      signedInRoutes({
        'POST /me/attendance/start': (init) => {
          bodies.start = JSON.parse(init.body);
          return json(201, {
            challengeId: 'c1',
            expiresInSeconds: 300,
            sentTo: '+91 ••••••0002',
            action: 'check_in',
            distanceM: 3.2,
          });
        },
        'POST /me/attendance/confirm': (init) => {
          bodies.confirm = JSON.parse(init.body);
          return json(201, {
            punchType: 'in',
            day: { status: 'checked_in', checkIn: '09:02', checkOut: null },
          });
        },
      }),
    );
    renderAt('/my-attendance');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Check in' }));
    expect(
      await screen.findByText(/Location verified \(3 m from the branch\)/),
    ).toBeInTheDocument();
    expect(bodies.start).toEqual({ latitude: 12.97163, longitude: 77.5946, accuracy: 6 });

    await user.type(screen.getByLabelText('6-digit code'), '424242');
    await user.click(screen.getByRole('button', { name: 'Confirm check in' }));
    expect(await screen.findByText('Checked in at 09:02.')).toBeInTheDocument();
    expect(bodies.confirm).toEqual({ challengeId: 'c1', code: '424242' });
  });

  it('explains a geofence rejection with the distance and does not ask for a code', async () => {
    mockGeolocation({ latitude: 12.9736, longitude: 77.5946, accuracy: 8 });
    mockApi(
      signedInRoutes({
        'POST /me/attendance/start': json(422, {
          error: {
            code: 'OUTSIDE_GEOFENCE',
            message: 'You are not at your branch. Attendance can only be marked at the clinic.',
            details: { distanceM: 222.4, accuracyM: 8, radiusM: 10 },
          },
        }),
      }),
    );
    renderAt('/my-attendance');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Check in' }));
    expect(
      await screen.findByText(/You are not at your branch.*about 222 m away; allowed 10 m/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('6-digit code')).not.toBeInTheDocument();
  });

  it('tells the employee how to fix a blocked location permission', async () => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (_ok, fail) => fail({ code: 1 }) },
    });
    const start = vi.fn();
    mockApi(signedInRoutes({ 'POST /me/attendance/start': start }));
    renderAt('/my-attendance');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Check in' }));
    await waitFor(() =>
      expect(screen.getByText(/Location permission is blocked/)).toBeInTheDocument(),
    );
    expect(start).not.toHaveBeenCalled();
  });
});
