import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/features/auth/auth-context';
import { tokenStore } from '@/lib/api-client';
import { App } from './App';

const ME = {
  user: { id: 'u1', email: 'asha@example.test', fullName: 'Asha Rao', mustChangePassword: false },
  organization: { id: 'o1', name: 'Sunrise Clinic', slug: 'sunrise', timezone: 'Asia/Kolkata' },
  roles: [{ role: 'organization_admin', label: 'Organization admin', branchId: null }],
  permissions: ['audit.read', 'branches.manage', 'branches.read', 'users.manage', 'users.read'],
  branchIds: null,
};

const json = (status, body) => ({
  ok: status < 400,
  status,
  statusText: 'x',
  json: async () => body,
});

/** Routes mocked fetch calls by method + path. */
function mockApi(routes) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init = {}) => {
    const path = String(url).replace(/^.*\/api\/v1/, '');
    const key = `${init.method ?? 'GET'} ${path.split('?')[0]}`;
    const handler = routes[key];
    if (!handler) return json(404, { error: { code: 'NOT_MOCKED', message: key } });
    return typeof handler === 'function' ? handler(init) : handler;
  });
}

function renderApp(path = '/') {
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

const noSession = json(401, { error: { code: 'INVALID_SESSION', message: 'Session ended' } });
const health = json(200, { status: 'ok', dependencies: { postgres: 'ok', redis: 'ok' } });

describe('authentication flow', () => {
  it('shows the sign-in page when there is no session', async () => {
    mockApi({ 'POST /auth/refresh': noSession });
    renderApp('/users');
    expect(await screen.findByRole('heading', { name: 'Sign in to HealthOS' })).toBeInTheDocument();
  });

  it('signs in and shows the dashboard with the organization and role', async () => {
    const fetchMock = mockApi({
      'POST /auth/refresh': noSession,
      'POST /auth/login': json(200, { accessToken: 'token-123', expiresIn: 900 }),
      'GET /auth/me': (init) =>
        init.headers.Authorization === 'Bearer token-123'
          ? json(200, ME)
          : json(401, { error: { code: 'UNAUTHENTICATED', message: 'no' } }),
      'GET /health/ready': health,
    });
    renderApp('/');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'asha@example.test');
    await user.type(screen.getByLabelText('Password'), 'a-long-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Welcome, Asha' })).toBeInTheDocument();
    expect(screen.getAllByText('Sunrise Clinic').length).toBeGreaterThan(0);
    const loginCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/auth/login'));
    expect(JSON.parse(loginCall[1].body)).toEqual({
      email: 'asha@example.test',
      password: 'a-long-password',
    });
  });

  it('shows the API error message when sign-in fails', async () => {
    mockApi({
      'POST /auth/refresh': noSession,
      'POST /auth/login': json(401, {
        error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' },
      }),
    });
    renderApp('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'asha@example.test');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Email or password is incorrect')).toBeInTheDocument();
  });

  it('forces a password change for temporary passwords', async () => {
    mockApi({
      'POST /auth/refresh': json(200, { accessToken: 't', expiresIn: 900 }),
      'GET /auth/me': json(200, { ...ME, user: { ...ME.user, mustChangePassword: true } }),
    });
    renderApp('/');
    expect(
      await screen.findByRole('heading', { name: 'Set your own password' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
  });

  it('restores the session from the refresh cookie on reload', async () => {
    mockApi({
      'POST /auth/refresh': json(200, { accessToken: 't', expiresIn: 900 }),
      'GET /auth/me': json(200, ME),
      'GET /health/ready': health,
    });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Welcome, Asha' })).toBeInTheDocument();
    expect(await screen.findByText('PostgreSQL')).toBeInTheDocument();
  });
});

describe('navigation by permission', () => {
  it('hides admin sections from a receptionist (the API enforces this too)', async () => {
    mockApi({
      'POST /auth/refresh': json(200, { accessToken: 't', expiresIn: 900 }),
      'GET /auth/me': json(200, {
        ...ME,
        roles: [{ role: 'receptionist', label: 'Receptionist', branchId: null }],
        permissions: ['branches.read'],
      }),
      'GET /health/ready': health,
    });
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(nav).toHaveTextContent('Branches');
    expect(nav).not.toHaveTextContent('Users & roles');
    expect(nav).not.toHaveTextContent('Audit log');
  });

  it('shows a no-access page when a receptionist opens an admin URL directly', async () => {
    const fetchMock = mockApi({
      'POST /auth/refresh': json(200, { accessToken: 't', expiresIn: 900 }),
      'GET /auth/me': json(200, {
        ...ME,
        roles: [{ role: 'receptionist', label: 'Receptionist', branchId: null }],
        permissions: ['branches.read'],
      }),
    });
    renderApp('/users');
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/users'))).toBe(false);
  });

  it('signs out locally when the session can no longer be refreshed', async () => {
    let meCalls = 0;
    mockApi({
      'POST /auth/refresh': () =>
        meCalls === 0 ? json(200, { accessToken: 't', expiresIn: 900 }) : noSession,
      'GET /auth/me': () => {
        meCalls += 1;
        return json(200, ME);
      },
      'GET /health/ready': health,
      'GET /branches': json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } }),
    });
    renderApp('/branches');
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Sign in to HealthOS' })).toBeInTheDocument(),
    );
  });
});
