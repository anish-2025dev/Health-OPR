import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
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
  Spinner,
} from '@/components/ui';

const schema = z.object({
  name: z.string().trim().min(2, 'At least 2 characters').max(200),
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{2,20}$/, '2–20 letters, digits or dashes'),
  address: z.string().trim().max(500).optional(),
});

function CreateBranchForm({ onDone }) {
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm({ resolver: zodResolver(schema) });
  const mutation = useMutation({
    mutationFn: (body) => apiFetch('/branches', { method: 'POST', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['branches'] });
      reset();
      onDone();
    },
  });

  return (
    <form
      onSubmit={handleSubmit((v) => mutation.mutate({ ...v, address: v.address || null }))}
      noValidate
      className="grid gap-4 sm:grid-cols-3"
    >
      <Field label="Branch name" htmlFor="b-name" error={errors.name?.message}>
        <Input id="b-name" placeholder="City Clinic, Indiranagar" {...register('name')} />
      </Field>
      <Field label="Code" htmlFor="b-code" error={errors.code?.message} hint="Short ID, e.g. IND-1">
        <Input id="b-code" className="uppercase" {...register('code')} />
      </Field>
      <Field label="Address (optional)" htmlFor="b-address" error={errors.address?.message}>
        <Input id="b-address" {...register('address')} />
      </Field>
      <div className="sm:col-span-3 flex items-center gap-2">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Add branch'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <div className="sm:col-span-3">
        <ErrorMessage error={mutation.error} />
      </div>
    </form>
  );
}

export function BranchesPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const canManage = auth.can('branches.manage');
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => apiFetch('/branches') });
  const toggle = useMutation({
    mutationFn: ({ id, status }) =>
      apiFetch(`/branches/${id}`, { method: 'PATCH', body: { status } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['branches'] }),
  });

  return (
    <>
      <PageHeader
        title="Branches"
        description="Clinic and hospital locations in your organization."
        actions={
          canManage && !adding && <Button onClick={() => setAdding(true)}>Add branch</Button>
        }
      />
      {adding && (
        <Card title="New branch" className="mb-6">
          <CreateBranchForm onDone={() => setAdding(false)} />
        </Card>
      )}
      <Card>
        {branches.isPending && <Spinner />}
        <ErrorMessage error={branches.error || toggle.error} />
        {branches.data && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Code</th>
                  <th className="py-2 pr-4">Address</th>
                  <th className="py-2 pr-4">Status</th>
                  {canManage && <th className="py-2" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {branches.data.data.map((b) => (
                  <tr key={b.id}>
                    <td className="py-2 pr-4 font-medium text-slate-800">{b.name}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{b.code}</td>
                    <td className="py-2 pr-4 text-slate-600">{b.address || '—'}</td>
                    <td className="py-2 pr-4">
                      <Badge tone={b.status === 'active' ? 'green' : 'slate'}>{b.status}</Badge>
                    </td>
                    {canManage && (
                      <td className="py-2 text-right">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={toggle.isPending}
                          onClick={() =>
                            toggle.mutate({
                              id: b.id,
                              status: b.status === 'active' ? 'inactive' : 'active',
                            })
                          }
                        >
                          {b.status === 'active' ? 'Deactivate' : 'Activate'}
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
