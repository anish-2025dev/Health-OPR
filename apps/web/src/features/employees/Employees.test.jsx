import { describe, expect, it, vi } from 'vitest';
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

const me = (permissions, role = 'hr_manager', label = 'HR manager') => ({
  user: { id: 'u1', email: 'hr@example.test', fullName: 'Hema HR', mustChangePassword: false },
  organization: { id: 'o1', name: 'Sunrise Clinic', slug: 'sunrise', timezone: 'Asia/Kolkata' },
  roles: [{ role, label, branchId: null }],
  permissions,
  branchIds: null,
});

const EMPLOYEE = {
  id: 'e1',
  employeeNumber: 'EMP-0001',
  fullName: 'Asha Rao',
  mobile: '+919876543210',
  email: null,
  branch: { id: 'b1', name: 'Main' },
  department: { id: 'd1', name: 'Nursing' },
  designation: null,
  shift: null,
  reportingManager: null,
  weeklyOffDays: [0],
  employmentType: 'full_time',
  employmentStatus: 'active',
  joiningDate: '2026-01-15',
  exitDate: null,
  emergencyContact: { name: null, phone: null },
};

const LOOKUPS = {
  'GET /branches': json(200, { data: [{ id: 'b1', name: 'Main', status: 'active' }] }),
  'GET /departments': json(200, { data: [{ id: 'd1', name: 'Nursing', status: 'active' }] }),
  'GET /designations': json(200, { data: [] }),
  'GET /shifts': json(200, { data: [] }),
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

const HR = [
  'employees.read',
  'employees.manage',
  'org_structure.manage',
  'holidays.read',
  'branches.read',
];

describe('employees list', () => {
  it('lists employees and lets HR add one', async () => {
    mockApi({
      'POST /auth/refresh': json(200, { accessToken: 't', expiresIn: 900 }),
      'GET /auth/me': json(200, me(HR)),
      'GET /hr/employees': json(200, { data: [EMPLOYEE], total: 1, limit: 100, offset: 0 }),
      ...LOOKUPS,
    });
    renderAt('/employees');
    expect(await screen.findByRole('link', { name: 'Asha Rao' })).toBeInTheDocument();
    expect(screen.getByText('EMP-0001')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add employee' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toHaveTextContent('Company setup');
  });

  it('payroll can view but not add employees, and has no company setup', async () => {
    mockApi({
      'POST /auth/refresh': json(200, { accessToken: 't', expiresIn: 900 }),
      'GET /auth/me': json(
        200,
        me(
          ['employees.read', 'holidays.read', 'branches.read'],
          'payroll_manager',
          'Payroll manager',
        ),
      ),
      'GET /hr/employees': json(200, {
        data: [{ ...EMPLOYEE, mobile: '+91 ••••••3210', emergencyContact: undefined }],
        total: 1,
        limit: 100,
        offset: 0,
      }),
      ...LOOKUPS,
    });
    renderAt('/employees');
    expect(await screen.findByText('+91 ••••••3210')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add employee' })).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).not.toHaveTextContent('Company setup');
  });
});

describe('add employee form', () => {
  it('validates required fields, then sends a clean payload', async () => {
    const post = vi.fn(() => json(201, { ...EMPLOYEE, id: 'e2' }));
    mockApi({
      'POST /auth/refresh': json(200, { accessToken: 't', expiresIn: 900 }),
      'GET /auth/me': json(200, me(HR)),
      'GET /hr/employees': json(200, { data: [], total: 0, limit: 200, offset: 0 }),
      'GET /hr/employees/e2': json(200, { ...EMPLOYEE, id: 'e2' }),
      'POST /hr/employees': (init) => post(JSON.parse(init.body)),
      ...LOOKUPS,
    });
    renderAt('/employees/new');
    const user = userEvent.setup();
    const submit = await screen.findByRole('button', { name: 'Create employee' });

    await user.click(submit);
    expect(await screen.findByText('At least 2 characters')).toBeInTheDocument();
    expect(screen.getByText('Choose a branch')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Full name'), 'Ravi Kumar');
    await user.type(screen.getByLabelText('Mobile'), '98765 43210');
    await waitFor(() => expect(screen.getByLabelText('Branch')).toHaveTextContent('Main'));
    await user.selectOptions(screen.getByLabelText('Branch'), 'b1');
    await user.selectOptions(screen.getByLabelText('Department'), 'd1');
    await user.type(screen.getByLabelText('Joining date'), '2026-03-01');
    await user.click(screen.getByLabelText('Sat'));
    await user.click(submit);

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toEqual({
      fullName: 'Ravi Kumar',
      mobile: '98765 43210',
      email: null,
      branchId: 'b1',
      departmentId: 'd1',
      designationId: null,
      shiftId: null,
      reportingManagerId: null,
      employmentType: 'full_time',
      joiningDate: '2026-03-01',
      weeklyOffDays: [0, 6],
      emergencyContactName: null,
      emergencyContactPhone: null,
    });
  });
});
