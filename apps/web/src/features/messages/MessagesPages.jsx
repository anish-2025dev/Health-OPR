import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
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
import { CATEGORY, when } from './shared';

// ------------------------------------------------------------------ compose + sent (HR, payroll, managers)
export function MessagesPage() {
  const qc = useQueryClient();
  const options = useQuery({
    queryKey: ['message-options'],
    queryFn: () => apiFetch('/messages/options'),
  });
  const sent = useQuery({ queryKey: ['messages-sent'], queryFn: () => apiFetch('/messages/sent') });
  const o = options.data;
  const [form, setForm] = useState({
    category: '',
    title: '',
    body: '',
    audienceType: '',
    employeeId: '',
    departmentId: '',
    branchId: '',
    smsAlert: false,
  });
  const [q, setQ] = useState('');
  const people = useQuery({
    queryKey: ['message-people', q],
    queryFn: () => apiFetch(`/hr/employees?status=active&limit=20&q=${encodeURIComponent(q)}`),
    enabled: Boolean(o?.wide) && q.trim().length >= 2,
  });
  const category = form.category || o?.categories[0] || '';
  const audienceType = form.audienceType || (o?.wide ? 'all' : 'team');
  const set = (k) => (e) =>
    setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const send = useMutation({
    mutationFn: () => {
      const audience =
        audienceType === 'employees'
          ? { type: 'employees', employeeIds: [form.employeeId] }
          : audienceType === 'department'
            ? { type: 'department', departmentId: form.departmentId || o.departments[0]?.id }
            : audienceType === 'branch'
              ? { type: 'branch', branchId: form.branchId || o.branches[0]?.id }
              : { type: audienceType };
      return apiFetch('/messages', {
        method: 'POST',
        body: { category, title: form.title, body: form.body, audience, smsAlert: form.smsAlert },
      });
    },
    onSuccess: () => {
      setForm((f) => ({ ...f, title: '', body: '', employeeId: '', smsAlert: false }));
      qc.invalidateQueries({ queryKey: ['messages-sent'] });
    },
  });

  return (
    <>
      <PageHeader
        title="Messages to employees"
        description="Payroll, performance, leave and general messages. Employees read them in the app under My messages."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <Card title="New message">
          {options.isPending && <Spinner />}
          <ErrorMessage error={options.error || send.error} />
          {send.isSuccess && (
            <Alert tone="green">Sent to {send.data.recipients} employee(s).</Alert>
          )}
          {o && (
            <form
              className="mt-2 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                send.mutate();
              }}
            >
              <Field label="Type" htmlFor="mc">
                <Select id="mc" value={category} onChange={set('category')}>
                  {o.categories.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY[c][0]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="To" htmlFor="ma">
                <Select id="ma" value={audienceType} onChange={set('audienceType')}>
                  {o.wide && <option value="all">All employees</option>}
                  {o.team.length > 0 && <option value="team">My team ({o.team.length})</option>}
                  <option value="employees">One employee</option>
                  {o.wide && o.departments.length > 0 && (
                    <option value="department">A department</option>
                  )}
                  {o.wide && <option value="branch">A branch</option>}
                </Select>
              </Field>
              {audienceType === 'employees' && !o.wide && (
                <Select
                  aria-label="Team member"
                  required
                  value={form.employeeId}
                  onChange={set('employeeId')}
                >
                  <option value="">Choose…</option>
                  {o.team.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.fullName} ({e.employeeNumber})
                    </option>
                  ))}
                </Select>
              )}
              {audienceType === 'employees' && o.wide && (
                <div>
                  <Input
                    aria-label="Find employee"
                    placeholder="Type a name or employee ID"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                  <Select
                    aria-label="Employee"
                    className="mt-1"
                    required
                    value={form.employeeId}
                    onChange={set('employeeId')}
                  >
                    <option value="">Choose…</option>
                    {people.data?.data.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.fullName} ({e.employeeNumber})
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              {audienceType === 'department' && (
                <Select
                  aria-label="Department"
                  value={form.departmentId}
                  onChange={set('departmentId')}
                >
                  {o.departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              )}
              {audienceType === 'branch' && (
                <Select aria-label="Branch" value={form.branchId} onChange={set('branchId')}>
                  {o.branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              )}
              <Field label="Title" htmlFor="mt">
                <Input
                  id="mt"
                  required
                  minLength={3}
                  maxLength={150}
                  value={form.title}
                  onChange={set('title')}
                />
              </Field>
              <Field label="Message" htmlFor="mb">
                <textarea
                  id="mb"
                  required
                  maxLength={4000}
                  rows={5}
                  className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  value={form.body}
                  onChange={set('body')}
                />
              </Field>
              {o.smsAlertAvailable && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.smsAlert} onChange={set('smsAlert')} />
                  Also send an SMS saying a new message is waiting (the text stays in the app)
                </label>
              )}
              <Button type="submit" disabled={send.isPending}>
                Send
              </Button>
            </form>
          )}
        </Card>
        <Card title="Sent">
          {sent.isPending && <Spinner />}
          <ErrorMessage error={sent.error} />
          {sent.data?.data.length === 0 && (
            <p className="text-sm text-slate-500">Nothing sent yet.</p>
          )}
          <ul className="divide-y divide-slate-100 text-sm">
            {sent.data?.data.map((m) => (
              <li key={m.id} className="py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{m.title}</span>
                  <Badge tone={CATEGORY[m.category][1]}>{CATEGORY[m.category][0]}</Badge>
                </div>
                <p className="text-xs text-slate-500">
                  {when(m.createdAt)} · {m.sender} → {m.audience} · read by {m.read}/{m.recipients}
                  {m.smsAlert ? ' · SMS alert' : ''}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ employee inbox
export function MyMessagesPage() {
  const qc = useQueryClient();
  const inbox = useQuery({ queryKey: ['my-messages'], queryFn: () => apiFetch('/me/messages') });
  const [open, setOpen] = useState(null);
  const read = useMutation({
    mutationFn: (id) => apiFetch(`/me/messages/${id}/read`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-messages'] }),
  });
  const readAll = useMutation({
    mutationFn: () => apiFetch('/me/messages/read-all', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-messages'] }),
  });
  return (
    <>
      <PageHeader
        title="My messages"
        description="Messages from HR, payroll and your manager."
        actions={
          inbox.data?.unread > 0 && (
            <Button variant="secondary" size="sm" onClick={() => readAll.mutate()}>
              Mark all as read
            </Button>
          )
        }
      />
      <Card>
        {inbox.isPending && <Spinner />}
        <ErrorMessage error={inbox.error} />
        {inbox.data?.data.length === 0 && (
          <p className="text-sm text-slate-500">No messages yet.</p>
        )}
        <ul className="divide-y divide-slate-100">
          {inbox.data?.data.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className="w-full py-3 text-left"
                onClick={() => {
                  setOpen(open === m.id ? null : m.id);
                  if (!m.readAt) read.mutate(m.id);
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`text-sm ${m.readAt ? 'text-slate-700' : 'font-semibold text-slate-900'}`}
                  >
                    {!m.readAt && (
                      <span className="mr-2 inline-block h-2 w-2 rounded-full bg-brand-600" />
                    )}
                    {m.title}
                  </span>
                  <Badge tone={CATEGORY[m.category][1]}>{CATEGORY[m.category][0]}</Badge>
                </div>
                <p className="text-xs text-slate-500">
                  {m.sender} · {when(m.createdAt)}
                </p>
                {open === m.id && (
                  <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{m.body}</p>
                )}
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
