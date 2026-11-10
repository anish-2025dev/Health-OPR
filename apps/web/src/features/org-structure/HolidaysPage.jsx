import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/features/auth/auth-context';
import {
  Badge,
  Button,
  Card,
  ErrorMessage,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui';

const formatDay = (iso) =>
  new Intl.DateTimeFormat('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00Z`));

export function HolidaysPage() {
  const auth = useAuth();
  const canManage = auth.can('org_structure.manage');
  const queryClient = useQueryClient();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [form, setForm] = useState({ date: '', name: '', branchId: '', isOptional: false });

  const holidays = useQuery({
    queryKey: ['holidays', year],
    queryFn: () => apiFetch(`/holidays?year=${year}`),
  });
  const branches = useQuery({
    queryKey: ['branches'],
    queryFn: () => apiFetch('/branches'),
    enabled: canManage,
  });
  const add = useMutation({
    mutationFn: () =>
      apiFetch('/holidays', {
        method: 'POST',
        body: { ...form, branchId: form.branchId || null },
      }),
    onSuccess: () => {
      setForm({ date: '', name: '', branchId: form.branchId, isOptional: false });
      queryClient.invalidateQueries({ queryKey: ['holidays'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id) => apiFetch(`/holidays/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['holidays'] }),
  });

  return (
    <>
      <PageHeader
        title="Holidays"
        description="Company holiday calendar. Branch-specific holidays apply only to that branch."
        actions={
          <Select
            aria-label="Year"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="w-28"
          >
            {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
        }
      />
      {canManage && (
        <Card title="Add holiday" className="mb-6">
          <form
            className="grid gap-3 sm:grid-cols-5"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <Field label="Date" htmlFor="h-date">
              <Input
                id="h-date"
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            </Field>
            <Field label="Name" htmlFor="h-name">
              <Input
                id="h-name"
                placeholder="Diwali"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Applies to" htmlFor="h-branch">
              <Select
                id="h-branch"
                value={form.branchId}
                onChange={(e) => setForm({ ...form, branchId: e.target.value })}
              >
                <option value="">All branches</option>
                {branches.data?.data.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="flex items-end gap-2 pb-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={form.isOptional}
                onChange={(e) => setForm({ ...form, isOptional: e.target.checked })}
              />
              Optional holiday
            </label>
            <div className="flex items-end">
              <Button
                type="submit"
                disabled={add.isPending || !form.date || form.name.trim().length < 2}
              >
                Add
              </Button>
            </div>
          </form>
          <div className="mt-3">
            <ErrorMessage error={add.error} />
          </div>
        </Card>
      )}
      <Card>
        {holidays.isPending && <Spinner />}
        <ErrorMessage error={holidays.error || remove.error} />
        <ul className="divide-y divide-slate-100">
          {holidays.data?.data.map((h) => (
            <li
              key={h.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <span className="flex items-center gap-3">
                <span className="w-28 font-mono text-xs text-slate-500">{formatDay(h.date)}</span>
                <span className="font-medium text-slate-800">{h.name}</span>
                {h.isOptional && <Badge tone="amber">optional</Badge>}
                <Badge>{h.branchName ?? 'All branches'}</Badge>
              </span>
              {canManage && (
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(h.id)}>
                  Remove
                </Button>
              )}
            </li>
          ))}
          {holidays.data?.data.length === 0 && (
            <li className="py-2 text-sm text-slate-500">No holidays added for {year}.</li>
          )}
        </ul>
      </Card>
    </>
  );
}
