import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/features/auth/auth-context';
import {
  Badge,
  Button,
  Card,
  ErrorMessage,
  Input,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui';
import { STATUS_LABEL, STATUS_TONE } from './status';

export function EmployeesPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const canManage = auth.can('employees.manage');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const [departmentId, setDepartmentId] = useState('');

  const params = new URLSearchParams({ status, limit: '100' });
  if (q.trim()) params.set('q', q.trim());
  if (departmentId) params.set('departmentId', departmentId);

  const employees = useQuery({
    queryKey: ['employees', params.toString()],
    queryFn: () => apiFetch(`/hr/employees?${params}`),
    placeholderData: keepPreviousData,
  });
  const departments = useQuery({
    queryKey: ['departments'],
    queryFn: () => apiFetch('/departments'),
  });

  return (
    <>
      <PageHeader
        title="Employees"
        description="Employee profiles, reporting lines and shifts."
        actions={
          canManage && (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => navigate('/employees/import')}>
                Upload from Excel
              </Button>
              <Button onClick={() => navigate('/employees/new')}>Add employee</Button>
            </div>
          )
        }
      />
      <Card>
        <div className="mb-4 grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
          <Input
            aria-label="Search employees"
            placeholder="Search by name or employee ID"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Select
            aria-label="Department"
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
          >
            <option value="">All departments</option>
            {departments.data?.data.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Active</option>
            <option value="on_notice">On notice</option>
            <option value="suspended">Suspended</option>
            <option value="exited">Exited</option>
            <option value="all">All statuses</option>
          </Select>
        </div>
        {employees.isPending && <Spinner />}
        <ErrorMessage error={employees.error} />
        {employees.data && (
          <>
            <p className="mb-2 text-xs text-slate-500">{employees.data.total} employees</p>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-2 pr-4">Employee</th>
                    <th className="py-2 pr-4">Department / designation</th>
                    <th className="py-2 pr-4">Branch</th>
                    <th className="py-2 pr-4">Reports to</th>
                    <th className="py-2 pr-4">Mobile</th>
                    <th className="py-2 pr-4">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {employees.data.data.map((e) => (
                    <tr key={e.id} className="hover:bg-slate-50">
                      <td className="py-2 pr-4">
                        <Link
                          to={`/employees/${e.id}`}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          {e.fullName}
                        </Link>
                        <p className="font-mono text-xs text-slate-500">{e.employeeNumber}</p>
                      </td>
                      <td className="py-2 pr-4 text-slate-700">
                        {e.department?.name ?? '—'}
                        <p className="text-xs text-slate-500">{e.designation?.name ?? ''}</p>
                      </td>
                      <td className="py-2 pr-4 text-slate-700">{e.branch.name}</td>
                      <td className="py-2 pr-4 text-slate-700">
                        {e.reportingManager?.name ?? '—'}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">{e.mobile}</td>
                      <td className="py-2 pr-4">
                        <Badge tone={STATUS_TONE[e.employmentStatus]}>
                          {STATUS_LABEL[e.employmentStatus]}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                  {employees.data.data.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-slate-500">
                        No employees match these filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </>
  );
}
