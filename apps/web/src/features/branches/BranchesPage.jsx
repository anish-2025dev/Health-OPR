import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { apiFetch } from '@/lib/api-client';
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

/** Branch location and check-in radius, used to verify attendance (Phase 9a). */
function GeofenceForm({ branch, onDone }) {
  const queryClient = useQueryClient();
  const [lat, setLat] = useState(branch.location?.latitude ?? '');
  const [lng, setLng] = useState(branch.location?.longitude ?? '');
  const [radius, setRadius] = useState(branch.geofenceRadiusM ?? 10);
  const [fix, setFix] = useState(null);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState(null);

  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/branches/${branch.id}`, {
        method: 'PATCH',
        body: {
          location: lat === '' ? null : { latitude: Number(lat), longitude: Number(lng) },
          geofenceRadiusM: Number(radius),
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['branches'] });
      onDone();
    },
  });

  const useCurrentLocation = () => {
    setGeoError(null);
    if (!navigator.geolocation) return setGeoError('This browser cannot share its location.');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setLat(pos.coords.latitude.toFixed(6));
        setLng(pos.coords.longitude.toFixed(6));
        setFix(Math.round(pos.coords.accuracy));
      },
      (err) => {
        setLocating(false);
        setGeoError(
          err.code === 1 ? 'Location permission was denied.' : 'Could not get a location fix.',
        );
      },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  };

  const latValid = lat === '' || (Number(lat) >= -90 && Number(lat) <= 90);
  const lngValid = lng === '' || (Number(lng) >= -180 && Number(lng) <= 180);
  const pairValid = (lat === '') === (lng === '');

  return (
    <Card title={`Attendance location: ${branch.name}`} className="mb-6">
      <p className="mb-4 text-sm text-slate-600">
        Attendance is accepted only when the employee&apos;s phone is within this radius of the
        branch. Stand inside the clinic and use your current location for the most accurate point.
      </p>
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Latitude" htmlFor="g-lat" error={latValid ? null : 'Between -90 and 90'}>
          <Input
            id="g-lat"
            inputMode="decimal"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
          />
        </Field>
        <Field label="Longitude" htmlFor="g-lng" error={lngValid ? null : 'Between -180 and 180'}>
          <Input
            id="g-lng"
            inputMode="decimal"
            value={lng}
            onChange={(e) => setLng(e.target.value)}
          />
        </Field>
        <Field label="Radius (metres)" htmlFor="g-radius" hint="5–1000 m">
          <Input
            id="g-radius"
            type="number"
            min="5"
            max="1000"
            value={radius}
            onChange={(e) => setRadius(e.target.value)}
          />
        </Field>
        <div className="flex items-end">
          <Button variant="secondary" onClick={useCurrentLocation} disabled={locating}>
            {locating ? 'Locating…' : 'Use my current location'}
          </Button>
        </div>
      </div>
      <div className="mt-4 space-y-3">
        {fix !== null && (
          <Alert tone={fix > Number(radius) ? 'amber' : 'green'}>
            Location captured with an accuracy of about ±{fix} m.
            {fix > Number(radius) &&
              ` That is less precise than the ${radius} m radius: phones indoors often report 15–50 m, so employees may be rejected. Consider a larger radius, or capture again near a window.`}
          </Alert>
        )}
        {Number(radius) < 30 && (
          <p className="text-xs text-slate-500">
            Tip: phone GPS inside buildings is often accurate to only 15–50 m. Test check-in with a
            few phones before go-live, and increase the radius if genuine staff are rejected.
          </p>
        )}
        {geoError && <Alert>{geoError}</Alert>}
        <ErrorMessage error={save.error} />
        <div className="flex gap-2">
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || !latValid || !lngValid || !pairValid}
          >
            {save.isPending ? 'Saving…' : 'Save location'}
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function BranchesPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [locating, setLocating] = useState(null);
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
      {locating && (
        <GeofenceForm key={locating.id} branch={locating} onDone={() => setLocating(null)} />
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
                  <th className="py-2 pr-4">Attendance location</th>
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
                      {b.location ? (
                        <Badge tone="green">Set · {b.geofenceRadiusM} m radius</Badge>
                      ) : (
                        <Badge tone="amber">Not set</Badge>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      <Badge tone={b.status === 'active' ? 'green' : 'slate'}>{b.status}</Badge>
                    </td>
                    {canManage && (
                      <td className="flex justify-end gap-2 py-2">
                        <Button size="sm" variant="secondary" onClick={() => setLocating(b)}>
                          Location
                        </Button>
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
