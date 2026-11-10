import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate, useParams } from 'react-router';
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
  Select,
  Spinner,
} from '@/components/ui';
import { STATUS_LABEL, STATUS_TONE } from './status';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const optional = (schema) => schema.optional().or(z.literal(''));

const schema = z
  .object({
    employeeNumber: optional(
      z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9-]{1,20}$/, 'Up to 20 letters, digits or dashes'),
    ),
    fullName: z.string().trim().min(2, 'At least 2 characters').max(200),
    mobile: z
      .string()
      .trim()
      .regex(/^(\+?[0-9][0-9\s-]{7,17})$/, 'Enter a valid mobile number'),
    email: optional(z.string().trim().email('Enter a valid email')),
    branchId: z.string().min(1, 'Choose a branch'),
    departmentId: z.string().optional(),
    designationId: z.string().optional(),
    shiftId: z.string().optional(),
    reportingManagerId: z.string().optional(),
    employmentType: z.enum(['full_time', 'part_time', 'contract', 'intern', 'consultant']),
    joiningDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date'),
    weeklyOffDays: z.array(z.string()),
    employmentStatus: z.enum(['active', 'on_notice', 'suspended', 'exited']),
    exitDate: z.string().optional(),
    emergencyContactName: z.string().trim().max(200).optional(),
    emergencyContactPhone: optional(
      z
        .string()
        .trim()
        .regex(/^(\+?[0-9][0-9\s-]{7,17})$/, 'Enter a valid number'),
    ),
  })
  .refine((v) => v.employmentStatus !== 'exited' || v.exitDate, {
    path: ['exitDate'],
    message: 'Exit date is required for exited employees',
  });

const nullIfEmpty = (v) => (v === '' || v === undefined ? null : v);

function toPayload(v, isNew) {
  const payload = {
    fullName: v.fullName,
    mobile: v.mobile,
    email: nullIfEmpty(v.email),
    branchId: v.branchId,
    departmentId: nullIfEmpty(v.departmentId),
    designationId: nullIfEmpty(v.designationId),
    shiftId: nullIfEmpty(v.shiftId),
    reportingManagerId: nullIfEmpty(v.reportingManagerId),
    employmentType: v.employmentType,
    joiningDate: v.joiningDate,
    weeklyOffDays: v.weeklyOffDays.map(Number),
    emergencyContactName: nullIfEmpty(v.emergencyContactName),
    emergencyContactPhone: nullIfEmpty(v.emergencyContactPhone),
  };
  if (isNew) {
    if (v.employeeNumber) payload.employeeNumber = v.employeeNumber;
  } else {
    payload.employmentStatus = v.employmentStatus;
    payload.exitDate = nullIfEmpty(v.exitDate);
  }
  return payload;
}

const fromEmployee = (e) => ({
  employeeNumber: e.employeeNumber,
  fullName: e.fullName,
  mobile: e.mobile,
  email: e.email ?? '',
  branchId: e.branch.id,
  departmentId: e.department?.id ?? '',
  designationId: e.designation?.id ?? '',
  shiftId: e.shift?.id ?? '',
  reportingManagerId: e.reportingManager?.id ?? '',
  employmentType: e.employmentType,
  joiningDate: e.joiningDate,
  weeklyOffDays: e.weeklyOffDays.map(String),
  employmentStatus: e.employmentStatus,
  exitDate: e.exitDate ?? '',
  emergencyContactName: e.emergencyContact?.name ?? '',
  emergencyContactPhone: e.emergencyContact?.phone ?? '',
});

const EMPTY = {
  employeeNumber: '',
  fullName: '',
  mobile: '',
  email: '',
  branchId: '',
  departmentId: '',
  designationId: '',
  shiftId: '',
  reportingManagerId: '',
  employmentType: 'full_time',
  joiningDate: '',
  weeklyOffDays: ['0'],
  employmentStatus: 'active',
  exitDate: '',
  emergencyContactName: '',
  emergencyContactPhone: '',
};

const activeOnly = (items, currentId) =>
  (items ?? []).filter((i) => i.status === 'active' || i.id === currentId);

export function EmployeeFormPage() {
  const { id } = useParams();
  const isNew = id === undefined;
  const auth = useAuth();
  const canManage = auth.can('employees.manage');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(false);

  const employee = useQuery({
    queryKey: ['employee', id],
    queryFn: () => apiFetch(`/hr/employees/${id}`),
    enabled: !isNew,
  });
  const lookups = {
    branches: useQuery({ queryKey: ['branches'], queryFn: () => apiFetch('/branches') }),
    departments: useQuery({ queryKey: ['departments'], queryFn: () => apiFetch('/departments') }),
    designations: useQuery({
      queryKey: ['designations'],
      queryFn: () => apiFetch('/designations'),
    }),
    shifts: useQuery({ queryKey: ['shifts'], queryFn: () => apiFetch('/shifts') }),
    managers: useQuery({
      queryKey: ['employees', 'managers'],
      queryFn: () => apiFetch('/hr/employees?status=active&limit=200'),
    }),
  };

  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors, isDirty },
  } = useForm({ resolver: zodResolver(schema), defaultValues: EMPTY });
  const status = useWatch({ control, name: 'employmentStatus' });

  useEffect(() => {
    if (employee.data) reset(fromEmployee(employee.data));
  }, [employee.data, reset]);

  const save = useMutation({
    mutationFn: (values) =>
      isNew
        ? apiFetch('/hr/employees', { method: 'POST', body: toPayload(values, true) })
        : apiFetch(`/hr/employees/${id}`, { method: 'PATCH', body: toPayload(values, false) }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['employees'] });
      queryClient.setQueryData(['employee', result.id], result);
      if (isNew) navigate(`/employees/${result.id}`, { replace: true, state: { created: true } });
      else {
        reset(fromEmployee(result));
        setSaved(true);
      }
    },
  });

  if (!isNew && employee.isPending) return <Spinner />;
  if (!isNew && employee.error) return <ErrorMessage error={employee.error} />;

  const readOnly = !canManage;
  const e = employee.data;

  return (
    <>
      <PageHeader
        title={isNew ? 'Add employee' : e.fullName}
        description={
          isNew
            ? 'Employee ID is generated automatically unless you enter one.'
            : `${e.employeeNumber} · ${e.branch.name}`
        }
        actions={
          <div className="flex items-center gap-2">
            {!isNew && (
              <Badge tone={STATUS_TONE[e.employmentStatus]}>
                {STATUS_LABEL[e.employmentStatus]}
              </Badge>
            )}
            <Link to="/employees" className="text-sm text-slate-600 hover:text-slate-900">
              ← All employees
            </Link>
          </div>
        }
      />
      {saved && !isDirty && (
        <div className="mb-4">
          <Alert tone="green">Changes saved.</Alert>
        </div>
      )}
      <form onSubmit={handleSubmit((v) => save.mutate(v))} noValidate>
        <fieldset disabled={readOnly || save.isPending} className="space-y-6">
          <Card title="Profile">
            <div className="grid gap-4 sm:grid-cols-3">
              {isNew && (
                <Field
                  label="Employee ID (optional)"
                  htmlFor="e-number"
                  hint="Leave blank to auto-generate (EMP-0001…)"
                  error={errors.employeeNumber?.message}
                >
                  <Input id="e-number" {...register('employeeNumber')} />
                </Field>
              )}
              <Field label="Full name" htmlFor="e-name" error={errors.fullName?.message}>
                <Input id="e-name" {...register('fullName')} />
              </Field>
              <Field
                label="Mobile"
                htmlFor="e-mobile"
                hint="Used for attendance OTPs"
                error={errors.mobile?.message}
              >
                <Input
                  id="e-mobile"
                  inputMode="tel"
                  placeholder="98765 43210"
                  {...register('mobile')}
                />
              </Field>
              <Field label="Email (optional)" htmlFor="e-email" error={errors.email?.message}>
                <Input id="e-email" type="email" {...register('email')} />
              </Field>
            </div>
          </Card>

          <Card title="Job">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Branch" htmlFor="e-branch" error={errors.branchId?.message}>
                <Select id="e-branch" {...register('branchId')}>
                  <option value="">Choose…</option>
                  {lookups.branches.data?.data.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Department" htmlFor="e-dept">
                <Select id="e-dept" {...register('departmentId')}>
                  <option value="">—</option>
                  {activeOnly(lookups.departments.data?.data, e?.department?.id).map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Designation" htmlFor="e-desig">
                <Select id="e-desig" {...register('designationId')}>
                  <option value="">—</option>
                  {activeOnly(lookups.designations.data?.data, e?.designation?.id).map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Reporting manager" htmlFor="e-manager">
                <Select id="e-manager" {...register('reportingManagerId')}>
                  <option value="">—</option>
                  {lookups.managers.data?.data
                    .filter((m) => m.id !== id)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.fullName} ({m.employeeNumber})
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Employment type" htmlFor="e-type">
                <Select id="e-type" {...register('employmentType')}>
                  <option value="full_time">Full-time</option>
                  <option value="part_time">Part-time</option>
                  <option value="contract">Contract</option>
                  <option value="intern">Intern</option>
                  <option value="consultant">Consultant</option>
                </Select>
              </Field>
              <Field label="Joining date" htmlFor="e-join" error={errors.joiningDate?.message}>
                <Input id="e-join" type="date" {...register('joiningDate')} />
              </Field>
            </div>
          </Card>

          <Card title="Schedule">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Shift" htmlFor="e-shift">
                <Select id="e-shift" {...register('shiftId')}>
                  <option value="">—</option>
                  {activeOnly(lookups.shifts.data?.data, e?.shift?.id).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.startTime}–{s.endTime})
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="sm:col-span-2">
                <p className="mb-1 text-sm font-medium text-slate-700">Weekly off days</p>
                <div className="flex flex-wrap gap-3">
                  {DAYS.map((day, i) => (
                    <label key={day} className="flex items-center gap-1.5 text-sm text-slate-700">
                      <input type="checkbox" value={String(i)} {...register('weeklyOffDays')} />
                      {day}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </Card>

          {(canManage || isNew) && (
            <Card title="Emergency contact">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Name" htmlFor="e-ec-name">
                  <Input id="e-ec-name" {...register('emergencyContactName')} />
                </Field>
                <Field
                  label="Phone"
                  htmlFor="e-ec-phone"
                  error={errors.emergencyContactPhone?.message}
                >
                  <Input id="e-ec-phone" inputMode="tel" {...register('emergencyContactPhone')} />
                </Field>
              </div>
            </Card>
          )}

          {!isNew && (
            <Card title="Employment status">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Status" htmlFor="e-status">
                  <Select id="e-status" {...register('employmentStatus')}>
                    <option value="active">Active</option>
                    <option value="on_notice">On notice</option>
                    <option value="suspended">Suspended</option>
                    <option value="exited">Exited</option>
                  </Select>
                </Field>
                {(status === 'exited' || status === 'on_notice') && (
                  <Field label="Exit date" htmlFor="e-exit" error={errors.exitDate?.message}>
                    <Input id="e-exit" type="date" {...register('exitDate')} />
                  </Field>
                )}
              </div>
            </Card>
          )}
        </fieldset>

        <div className="mt-6 space-y-3">
          <ErrorMessage error={save.error} />
          {canManage && (
            <Button type="submit" disabled={save.isPending || (!isNew && !isDirty)}>
              {save.isPending ? 'Saving…' : isNew ? 'Create employee' : 'Save changes'}
            </Button>
          )}
        </div>
      </form>
    </>
  );
}
