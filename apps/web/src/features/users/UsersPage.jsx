import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { apiFetch } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { useAuth } from '@/features/auth/auth-context';
import {
  Alert,
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

const schema = z.object({
  fullName: z.string().trim().min(2, 'At least 2 characters').max(200),
  email: z.string().trim().email('Enter a valid email'),
  phone: z
    .string()
    .trim()
    .regex(/^(\+[1-9][0-9]{7,14})?$/, 'Use international format, e.g. +919876543210')
    .optional(),
  role: z.string().min(1, 'Choose a role'),
  branchId: z.string().optional(),
});

/** Shows a one-time temporary password with a copy button. */
function TemporaryPassword({ who, password, onClose }) {
  const [copied, setCopied] = useState(false);
  return (
    <Alert tone="amber">
      <p className="font-medium">Temporary password for {who}</p>
      <p className="mt-1">
        Share it privately. It is shown <strong>only once</strong>, and they must change it at first
        sign-in.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="rounded bg-white px-2 py-1 font-mono text-base text-slate-900">
          {password}
        </code>
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard?.writeText(password);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Done
        </Button>
      </div>
    </Alert>
  );
}

function CreateUserForm({ roles, branches, onCreated, onCancel }) {
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({ resolver: zodResolver(schema), defaultValues: { branchId: '' } });
  const mutation = useMutation({
    mutationFn: (v) =>
      apiFetch('/users', {
        method: 'POST',
        body: {
          fullName: v.fullName,
          email: v.email,
          phone: v.phone || null,
          roles: [{ role: v.role, branchId: v.branchId || null }],
        },
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      onCreated(result);
    },
  });

  return (
    <form
      onSubmit={handleSubmit((v) => mutation.mutate(v))}
      noValidate
      className="grid gap-4 sm:grid-cols-2"
    >
      <Field label="Full name" htmlFor="u-name" error={errors.fullName?.message}>
        <Input id="u-name" {...register('fullName')} />
      </Field>
      <Field label="Work email" htmlFor="u-email" error={errors.email?.message}>
        <Input id="u-email" type="email" {...register('email')} />
      </Field>
      <Field label="Mobile (optional)" htmlFor="u-phone" error={errors.phone?.message}>
        <Input id="u-phone" placeholder="+91…" {...register('phone')} />
      </Field>
      <Field label="Role" htmlFor="u-role" error={errors.role?.message}>
        <Select id="u-role" {...register('role')}>
          <option value="">Choose…</option>
          {roles
            .filter((r) => r.assignable)
            .map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
        </Select>
      </Field>
      <Field
        label="Branch access"
        htmlFor="u-branch"
        hint="Limit this role to one branch, or allow all."
      >
        <Select id="u-branch" {...register('branchId')}>
          <option value="">All branches</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex items-end gap-2">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Creating…' : 'Create user'}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <div className="sm:col-span-2">
        <ErrorMessage error={mutation.error} />
      </div>
    </form>
  );
}

export function UsersPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canManage = auth.can('users.manage');
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState(null);

  const users = useQuery({ queryKey: ['users'], queryFn: () => apiFetch('/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => apiFetch('/users/roles') });
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => apiFetch('/branches') });
  const branchName = (id) => branches.data?.data.find((b) => b.id === id)?.name ?? 'branch';

  const setStatus = useMutation({
    mutationFn: ({ id, status }) => apiFetch(`/users/${id}`, { method: 'PATCH', body: { status } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });
  const resetPassword = useMutation({
    mutationFn: (user) =>
      apiFetch(`/users/${user.id}/reset-password`, { method: 'POST' }).then((r) => ({
        user,
        ...r,
      })),
    onSuccess: ({ user, temporaryPassword }) => {
      setSecret({ who: user.fullName, password: temporaryPassword });
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  return (
    <>
      <PageHeader
        title="Users & roles"
        description="Staff accounts and what each person can access."
        actions={canManage && !adding && <Button onClick={() => setAdding(true)}>Add user</Button>}
      />
      {secret && (
        <div className="mb-6">
          <TemporaryPassword {...secret} onClose={() => setSecret(null)} />
        </div>
      )}
      {adding && roles.data && branches.data && (
        <Card title="New user" className="mb-6">
          <CreateUserForm
            roles={roles.data.data}
            branches={branches.data.data}
            onCancel={() => setAdding(false)}
            onCreated={({ user, temporaryPassword }) => {
              setAdding(false);
              setSecret({ who: user.fullName, password: temporaryPassword });
            }}
          />
        </Card>
      )}
      <Card>
        {users.isPending && <Spinner />}
        <ErrorMessage error={users.error || setStatus.error || resetPassword.error} />
        {users.data && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Roles</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Last sign-in</th>
                  {canManage && <th className="py-2" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.data.data.map((u) => {
                  const isSelf = u.id === auth.me.user.id;
                  return (
                    <tr key={u.id}>
                      <td className="py-2 pr-4">
                        <p className="font-medium text-slate-800">{u.fullName}</p>
                        <p className="text-xs text-slate-500">{u.email}</p>
                      </td>
                      <td className="py-2 pr-4">
                        <div className="flex flex-wrap gap-1">
                          {u.roles.map((r) => (
                            <Badge key={`${r.role}-${r.branchId}`} tone="brand">
                              {r.label}
                              {r.branchId ? ` · ${branchName(r.branchId)}` : ''}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="py-2 pr-4">
                        <div className="flex flex-wrap gap-1">
                          <Badge tone={u.status === 'active' ? 'green' : 'red'}>{u.status}</Badge>
                          {u.mustChangePassword && <Badge tone="amber">temp password</Badge>}
                        </div>
                      </td>
                      <td className="py-2 pr-4 text-slate-600">
                        {formatDateTime(u.lastLoginAt, auth.me.organization.timezone)}
                      </td>
                      {canManage && (
                        <td className="py-2 text-right whitespace-nowrap">
                          {!isSelf && (
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={resetPassword.isPending}
                                onClick={() => resetPassword.mutate(u)}
                              >
                                Reset password
                              </Button>
                              <Button
                                size="sm"
                                variant={u.status === 'active' ? 'danger' : 'secondary'}
                                disabled={setStatus.isPending}
                                onClick={() =>
                                  setStatus.mutate({
                                    id: u.id,
                                    status: u.status === 'active' ? 'disabled' : 'active',
                                  })
                                }
                              >
                                {u.status === 'active' ? 'Disable' : 'Enable'}
                              </Button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
