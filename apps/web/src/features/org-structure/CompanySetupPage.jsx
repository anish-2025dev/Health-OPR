import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import {
  Badge,
  Button,
  Card,
  ErrorMessage,
  Field,
  Input,
  PageHeader,
  Spinner,
} from '@/components/ui';

/** Departments / designations: a list of names with add, rename-free deactivate/activate. */
function NamedList({ resource, title, placeholder }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const list = useQuery({ queryKey: [resource], queryFn: () => apiFetch(`/${resource}`) });
  const add = useMutation({
    mutationFn: () => apiFetch(`/${resource}`, { method: 'POST', body: { name } }),
    onSuccess: () => {
      setName('');
      queryClient.invalidateQueries({ queryKey: [resource] });
    },
  });
  const toggle = useMutation({
    mutationFn: (item) =>
      apiFetch(`/${resource}/${item.id}`, {
        method: 'PATCH',
        body: { status: item.status === 'active' ? 'inactive' : 'active' },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [resource] }),
  });

  return (
    <Card title={title}>
      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim().length >= 2) add.mutate();
        }}
      >
        <Input
          aria-label={`New ${title.toLowerCase()} name`}
          placeholder={placeholder}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" disabled={add.isPending || name.trim().length < 2}>
          Add
        </Button>
      </form>
      <ErrorMessage error={add.error || toggle.error || list.error} />
      {list.isPending && <Spinner />}
      <ul className="divide-y divide-slate-100">
        {list.data?.data.map((item) => (
          <li key={item.id} className="flex items-center justify-between py-2 text-sm">
            <span className={item.status === 'active' ? 'text-slate-800' : 'text-slate-400'}>
              {item.name}
            </span>
            <span className="flex items-center gap-2">
              {item.status !== 'active' && <Badge>inactive</Badge>}
              <Button size="sm" variant="ghost" onClick={() => toggle.mutate(item)}>
                {item.status === 'active' ? 'Deactivate' : 'Activate'}
              </Button>
            </span>
          </li>
        ))}
        {list.data?.data.length === 0 && <li className="py-2 text-sm text-slate-500">None yet.</li>}
      </ul>
    </Card>
  );
}

const fmtMinutes = (m) => `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;

function Shifts() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: '',
    startTime: '09:00',
    endTime: '18:00',
    breakMinutes: 60,
  });
  const list = useQuery({ queryKey: ['shifts'], queryFn: () => apiFetch('/shifts') });
  const add = useMutation({
    mutationFn: () =>
      apiFetch('/shifts', {
        method: 'POST',
        body: { ...form, breakMinutes: Number(form.breakMinutes) || 0 },
      }),
    onSuccess: () => {
      setForm((f) => ({ ...f, name: '' }));
      queryClient.invalidateQueries({ queryKey: ['shifts'] });
    },
  });
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <Card title="Shifts">
      <form
        className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field label="Name" htmlFor="s-name">
          <Input id="s-name" placeholder="Morning" value={form.name} onChange={set('name')} />
        </Field>
        <Field label="Start" htmlFor="s-start">
          <Input id="s-start" type="time" value={form.startTime} onChange={set('startTime')} />
        </Field>
        <Field label="End" htmlFor="s-end">
          <Input id="s-end" type="time" value={form.endTime} onChange={set('endTime')} />
        </Field>
        <Field label="Break (min)" htmlFor="s-break">
          <Input
            id="s-break"
            type="number"
            min="0"
            max="240"
            value={form.breakMinutes}
            onChange={set('breakMinutes')}
          />
        </Field>
        <div className="flex items-end">
          <Button type="submit" disabled={add.isPending || form.name.trim().length < 2}>
            Add shift
          </Button>
        </div>
      </form>
      <ErrorMessage error={add.error || list.error} />
      <ul className="divide-y divide-slate-100">
        {list.data?.data.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <span className="font-medium text-slate-800">{s.name}</span>
            <span className="text-slate-600">
              {s.startTime}–{s.endTime}
              {s.overnight && ' (overnight)'} · break {s.breakMinutes} min · work{' '}
              {fmtMinutes(s.workMinutes)}
            </span>
          </li>
        ))}
        {list.data?.data.length === 0 && <li className="py-2 text-sm text-slate-500">None yet.</li>}
      </ul>
    </Card>
  );
}

export function CompanySetupPage() {
  return (
    <>
      <PageHeader
        title="Company setup"
        description="Departments, designations and shift timings used in employee profiles."
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <NamedList resource="departments" title="Departments" placeholder="e.g. Nursing" />
        <NamedList resource="designations" title="Designations" placeholder="e.g. Staff Nurse" />
        <div className="lg:col-span-2">
          <Shifts />
        </div>
      </div>
    </>
  );
}
