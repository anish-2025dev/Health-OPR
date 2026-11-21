import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/features/auth/auth-context';
import { tokenStore } from '@/lib/api-client';
import { MgtAppContent } from '@/mgt/MgtApp';
import { OpsAppContent } from '@/ops/OpsApp';
import { Root } from './Root';

const json = (status, body) => ({
  ok: status < 400,
  status,
  statusText: 'x',
  json: async () => body,
});

function mockApi(routes) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init = {}) => {
    const path = String(url).replace(/^.*\/api\/v1/, '');
    const key = `${init.method ?? 'GET'} ${path.split('?')[0]}`;
    const handler = routes[key];
    if (!handler) return json(404, { error: { code: 'NOT_MOCKED', message: key } });
    return typeof handler === 'function' ? handler(init) : handler;
  });
}

function renderWithClient(ui) {
  tokenStore.clear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('Suntek Ecosystem — Independent Frontend Surfaces (Phase 3)', () => {
  const HR_USER = {
    user: { id: 'u_hr', email: 'hr@hospital.org', fullName: 'Hema HR', mustChangePassword: false },
    organization: {
      id: 'org1',
      name: 'Apex General Hospital',
      slug: 'apex',
      timezone: 'Asia/Kolkata',
    },
    roles: [{ role: 'hr_manager', label: 'HR manager', branchId: null }],
    permissions: [
      'employees.read',
      'employees.manage',
      'attendance.read',
      'leave.read',
      'payroll.read',
      'org_structure.manage',
      'branches.read',
    ],
    branchIds: null,
  };

  const CLINICAL_USER = {
    user: {
      id: 'u_doc',
      email: 'doc@hospital.org',
      fullName: 'Dr. David',
      mustChangePassword: false,
    },
    organization: {
      id: 'org1',
      name: 'Apex General Hospital',
      slug: 'apex',
      timezone: 'Asia/Kolkata',
    },
    roles: [{ role: 'doctor', label: 'Doctor', branchId: null }],
    permissions: [
      'appointments.read',
      'appointments.manage',
      'queue.manage',
      'patients.read',
      'branches.read',
    ],
    branchIds: null,
  };

  it('renders Suntek-Mgt surface with workforce navigation and no clinical links', async () => {
    mockApi({
      'POST /auth/refresh': json(200, { accessToken: 'tok_hr' }),
      'GET /auth/me': json(200, HR_USER),
      'GET /health': json(200, { status: 'ok', dependencies: { postgres: 'ok', redis: 'ok' } }),
      'GET /me/messages/unread-count': json(200, { unread: 0 }),
    });

    renderWithClient(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <MgtAppContent />
        </AuthProvider>
      </MemoryRouter>,
    );

    // Verify Suntek-Mgt Branding
    expect(await screen.findByText('Suntek-Mgt')).toBeInTheDocument();
    expect(screen.getByText('HRMS')).toBeInTheDocument();
    expect(screen.getByText('Suntek-Mgt · Workforce Operations')).toBeInTheDocument();

    // Verify Workforce navigation items are present
    expect(screen.getByRole('link', { name: 'Employees' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Attendance' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Payroll' })).toBeInTheDocument();

    // Verify Clinical navigation items are strictly absent
    expect(screen.queryByRole('link', { name: 'Patients' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Doctors' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Reception & queue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Clinic today' })).not.toBeInTheDocument();
  });

  it('renders Suntek-ops surface with clinical navigation and no workforce links', async () => {
    mockApi({
      'POST /auth/refresh': json(200, { accessToken: 'tok_doc' }),
      'GET /auth/me': json(200, CLINICAL_USER),
      'GET /health': json(200, { status: 'ok', dependencies: { postgres: 'ok', redis: 'ok' } }),
      'GET /queue': json(200, { entries: [] }),
      'GET /doctors': json(200, []),
    });

    renderWithClient(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <OpsAppContent />
        </AuthProvider>
      </MemoryRouter>,
    );

    // Verify Suntek-ops Branding
    expect(await screen.findByText('Suntek-ops')).toBeInTheDocument();
    expect(screen.getByText('Clinic')).toBeInTheDocument();
    expect(screen.getByText('Suntek-ops · Hospital Operations')).toBeInTheDocument();

    // Verify Clinical navigation items are present
    expect(screen.getByRole('link', { name: 'Patients' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Doctors' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Clinic today' })).toBeInTheDocument();

    // Verify Workforce navigation items are strictly absent
    expect(screen.queryByRole('link', { name: 'Employees' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Attendance' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Payroll' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Holidays' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Company setup' })).not.toBeInTheDocument();
  });

  it('renders Root surface wrapper component without throwing', () => {
    tokenStore.clear();
    const client = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Root />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(container).toBeDefined();
  });
});
