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

const STATUS_TONE = { sent: 'green', failed: 'red', skipped: 'slate' };

export function MessagingPage() {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ['whatsapp-settings'],
    queryFn: () => apiFetch('/integrations/whatsapp'),
  });
  const log = useQuery({
    queryKey: ['notification-log'],
    queryFn: () => apiFetch('/integrations/notifications'),
  });
  const [form, setForm] = useState(null);
  const current =
    form ??
    (settings.data && {
      phoneNumberId: settings.data.channel?.phoneNumberId ?? '',
      displayPhone: settings.data.channel?.displayPhone ?? '',
      status: settings.data.channel?.status ?? 'active',
    });
  const save = useMutation({
    mutationFn: () =>
      apiFetch('/integrations/whatsapp', {
        method: 'PUT',
        body: {
          phoneNumberId: current.phoneNumberId.trim(),
          displayPhone: current.displayPhone.trim() || null,
          status: current.status,
        },
      }),
    onSuccess: () => {
      setForm(null);
      qc.invalidateQueries({ queryKey: ['whatsapp-settings'] });
    },
  });

  return (
    <>
      <PageHeader
        title="WhatsApp & SMS"
        description="Patients who are already registered can book, check and cancel appointments on WhatsApp. Confirmations go out by WhatsApp or SMS, depending on each patient's consent."
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Hospital WhatsApp number">
          {settings.isPending && <Spinner />}
          <ErrorMessage error={settings.error || save.error} />
          {settings.data && !settings.data.providerReady && (
            <Alert tone="amber">
              WhatsApp isn&apos;t connected on the server yet. Your platform administrator sets the
              WhatsApp Business account details. You can still save your number here.
            </Alert>
          )}
          {settings.data?.providerReady && !settings.data.appointmentTemplateSet && (
            <Alert tone="amber">
              Booking on WhatsApp works, but appointment confirmations need an approved message
              template set on the server.
            </Alert>
          )}
          {current && (
            <form
              className="mt-3 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              <Field
                label="Phone number ID"
                htmlFor="wpid"
                hint="From Meta: WhatsApp Manager → Phone numbers → your number → Phone number ID"
              >
                <Input
                  id="wpid"
                  required
                  inputMode="numeric"
                  value={current.phoneNumberId}
                  onChange={(e) => setForm({ ...current, phoneNumberId: e.target.value })}
                />
              </Field>
              <Field label="Number shown to patients (optional)" htmlFor="wdp">
                <Input
                  id="wdp"
                  placeholder="+91 …"
                  value={current.displayPhone}
                  onChange={(e) => setForm({ ...current, displayPhone: e.target.value })}
                />
              </Field>
              <Field label="Status" htmlFor="wst">
                <Select
                  id="wst"
                  value={current.status}
                  onChange={(e) => setForm({ ...current, status: e.target.value })}
                >
                  <option value="active">Active</option>
                  <option value="paused">Paused (ignore incoming messages)</option>
                </Select>
              </Field>
              <Button type="submit" disabled={save.isPending}>
                Save
              </Button>
            </form>
          )}
        </Card>
        <Card title="How it works for patients">
          <ul className="list-disc space-y-2 pl-5 text-sm text-slate-600">
            <li>
              Only patients already registered on that phone number can book. Others are sent the
              registration link. WhatsApp never creates a patient record.
            </li>
            <li>
              If several family members share the number, the patient is asked who the booking is
              for.
            </li>
            <li>
              Family members still awaiting your check (Patient privacy → Family links) are not
              offered.
            </li>
            <li>Replying STOP withdraws WhatsApp consent for that number&apos;s patients.</li>
            <li>
              Messages contain no medical details: only date, time, token and a live-status link.
            </li>
          </ul>
        </Card>
      </div>
      <Card title="Recent appointment confirmations" className="mt-6">
        {log.isPending && <Spinner />}
        <ErrorMessage error={log.error} />
        {log.data?.data.length === 0 && <p className="text-sm text-slate-500">Nothing sent yet.</p>}
        <ul className="divide-y divide-slate-100 text-sm">
          {log.data?.data.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                {new Date(n.createdAt).toLocaleString('en-IN')} · {n.patient?.fullName ?? '—'}
                {n.reason && <span className="block text-xs text-slate-500">{n.reason}</span>}
              </span>
              <span className="flex items-center gap-2">
                <span className="text-xs text-slate-500">{n.channel}</span>
                <Badge tone={STATUS_TONE[n.status]}>{n.status}</Badge>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
