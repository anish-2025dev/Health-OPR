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
const ME = {
  user: { id: 'u9', email: null, fullName: 'Wendy Worker', mustChangePassword: false },
  organization: { id: 'o1', name: 'Sunrise Clinic', slug: 'sunrise', timezone: 'Asia/Kolkata' },
  roles: [{ role: 'employee', label: 'Employee', branchId: null }],
  permissions: ['holidays.read'],
  branchIds: null,
  employee: {
    id: 'e2',
    employeeNumber: 'EMP-0002',
    fullName: 'Wendy Worker',
    branchId: 'b1',
    status: 'active',
    isManager: false,
  },
};
const CL = {
  id: 't1',
  name: 'Casual Leave',
  code: 'CL',
  isPaid: true,
  annualQuota: 12,
  accrual: 'yearly_upfront',
  carryForwardMax: 0,
  allowHalfDay: true,
  minNoticeDays: 0,
  maxConsecutiveDays: 3,
  approvalLevels: 1,
  status: 'active',
};

describe('My leave', () => {
  it('shows balances, previews the days and sends the request', async () => {
    const posted = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init = {}) => {
      const key = `${init.method ?? 'GET'} ${
        String(url)
          .replace(/^.*\/api\/v1/, '')
          .split('?')[0]
      }`;
      switch (key) {
        case 'POST /auth/refresh':
          return json(200, { accessToken: 't', expiresIn: 900 });
        case 'GET /auth/me':
          return json(200, ME);
        case 'GET /me/leave/balances':
          return json(200, {
            year: 2026,
            range: { start: '2026-01-01', end: '2026-12-31' },
            balances: [{ type: CL, accrued: 12, adjusted: 0, used: 2, pending: 0, available: 10 }],
          });
        case 'GET /leave/types':
          return json(200, { data: [CL] });
        case 'GET /me/leave/requests':
          return json(200, { data: [] });
        case 'POST /me/leave/preview':
          return json(200, { days: 2, year: 2026, balanceAfter: 8 });
        case 'POST /me/leave/requests':
          posted.push(JSON.parse(init.body));
          return json(201, { id: 'r1' });
        default:
          return json(404, { error: { code: 'NOT_MOCKED', message: key } });
      }
    });
    tokenStore.clear();
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter initialEntries={['/my-leave']}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('10')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Apply for leave' }));
    await user.selectOptions(await screen.findByLabelText('Leave type'), 't1');
    await user.type(screen.getByLabelText('From'), '2026-12-01');
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), '2026-12-02');
    await user.type(screen.getByLabelText('Reason'), 'Family function');
    expect(
      await screen.findByText(/2 working day\(s\)\. Balance after approval: 8\./),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      leaveTypeId: 't1',
      startDate: '2026-12-01',
      endDate: '2026-12-02',
      reason: 'Family function',
    });
  });
});
