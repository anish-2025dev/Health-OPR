import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { readSheet } from 'read-excel-file/browser';
import { apiFetch } from '@/lib/api-client';
import { Alert, Badge, Button, Card, ErrorMessage, PageHeader } from '@/components/ui';
import { parseCsv, toCsv, toRecords } from './csv';

const COLUMNS = [
  ['Employee ID', 'Optional. Left empty: EMP-0001, EMP-0002…'],
  ['Full Name', 'Required'],
  ['Mobile', 'Required. 10-digit mobile; used for employee sign-in'],
  ['Email', 'Optional'],
  ['Branch', 'Required. Branch code or name'],
  ['Department', 'Optional. Must exist, or tick "create missing"'],
  ['Designation', 'Optional. Same as department'],
  ['Shift', 'Optional. Shift name (must exist)'],
  ['Reports To', "Optional. Manager's Employee ID or mobile (can be in the same file)"],
  ['Joining Date', 'Required. DD-MM-YYYY'],
  ['Employment Type', 'Optional. Full time, part time, contract, intern, consultant'],
  ['Weekly Off', 'Optional. e.g. Sun, or Sat, Sun (default Sun)'],
  ['Emergency Contact Name', 'Optional'],
  ['Emergency Contact Phone', 'Optional'],
];

function downloadTemplate() {
  const csv = toCsv([
    COLUMNS.map(([c]) => c),
    [
      'EMP-0101',
      'Example Manager',
      '9000000501',
      '',
      'MAIN',
      'Nursing',
      'Head Nurse',
      '',
      '',
      '01-04-2024',
      'Full time',
      'Sun',
      '',
      '',
    ],
    [
      '',
      'Example Nurse',
      '9000000502',
      '',
      'MAIN',
      'Nursing',
      'Staff Nurse',
      '',
      'EMP-0101',
      '15-06-2025',
      'Full time',
      'Sat, Sun',
      '',
      '',
    ],
  ]);
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: 'employees-template.csv',
  });
  a.click();
  URL.revokeObjectURL(url);
}

async function readFile(file) {
  if (/\.xlsx$/i.test(file.name)) return toRecords(await readSheet(file));
  if (/\.csv$/i.test(file.name)) return toRecords(parseCsv(await file.text()));
  throw new Error(
    'Choose an Excel (.xlsx) or CSV (.csv) file. Old .xls files: open in Excel and save as .xlsx.',
  );
}

export function ImportEmployeesPage() {
  const qc = useQueryClient();
  const [file, setFile] = useState(null);
  const [rows, setRows] = useState(null);
  const [readError, setReadError] = useState(null);
  const [createMissing, setCreateMissing] = useState(true);
  const check = useMutation({
    mutationFn: () =>
      apiFetch('/hr/employees/import', {
        method: 'POST',
        body: { rows, dryRun: true, createMissing },
      }),
  });
  const doImport = useMutation({
    mutationFn: () =>
      apiFetch('/hr/employees/import', {
        method: 'POST',
        body: { rows, dryRun: false, createMissing },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employees'] }),
  });
  const result = check.data;
  const ready = result && result.errorCount === 0 && !doImport.isSuccess;

  const choose = async (f) => {
    setFile(f);
    setRows(null);
    setReadError(null);
    check.reset();
    doImport.reset();
    if (!f) return;
    try {
      const r = await readFile(f);
      if (!r.length) throw new Error('The file has no rows under the header row.');
      if (r.length > 1000)
        throw new Error('Up to 1000 employees per file. Split the file and upload in parts.');
      setRows(r);
    } catch (err) {
      setReadError(err);
    }
  };

  return (
    <>
      <PageHeader
        title="Upload employees"
        description="Add many employees at once from Excel or CSV. Nothing is saved until every row is correct."
        actions={
          <Link to="/employees" className="text-sm text-brand-700">
            ← Employees
          </Link>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <Card title="1. Prepare the file">
          <p className="text-sm text-slate-600">
            Use the template, or any sheet whose first row has these column names. Upper/lower case
            and spaces in the headers don&apos;t matter.
          </p>
          <Button className="mt-3" variant="secondary" onClick={downloadTemplate}>
            Download template (CSV, opens in Excel)
          </Button>
          <table className="mt-4 w-full text-left text-xs">
            <tbody className="divide-y divide-slate-100">
              {COLUMNS.map(([c, hint]) => (
                <tr key={c}>
                  <td className="py-1.5 pr-3 font-medium text-slate-800">{c}</td>
                  <td className="py-1.5 text-slate-500">{hint}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="2. Upload and check">
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Excel (.xlsx) or CSV file</span>
            <input
              type="file"
              accept=".xlsx,.csv"
              className="mt-2 block w-full text-sm"
              onChange={(e) => choose(e.target.files?.[0] ?? null)}
            />
          </label>
          {readError && (
            <div className="mt-3">
              <Alert>{readError.message}</Alert>
            </div>
          )}
          {rows && (
            <p className="mt-3 text-sm text-slate-600">
              {file.name}: <strong>{rows.length}</strong> row(s) found.
            </p>
          )}
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={createMissing}
              onChange={(e) => (setCreateMissing(e.target.checked), check.reset())}
            />
            Create departments and designations that don&apos;t exist yet
          </label>
          <div className="mt-4 flex gap-2">
            <Button disabled={!rows || check.isPending} onClick={() => check.mutate()}>
              {check.isPending ? 'Checking…' : 'Check file'}
            </Button>
            <Button
              variant="secondary"
              disabled={!ready || doImport.isPending}
              onClick={() => doImport.mutate()}
            >
              {doImport.isPending ? 'Importing…' : `Import ${rows?.length ?? ''} employees`}
            </Button>
          </div>
          <div className="mt-3 space-y-2">
            <ErrorMessage error={check.error || doImport.error} />
            {result && result.errorCount > 0 && (
              <Alert tone="amber">
                {result.errorCount} row(s) need fixing. Correct them in your file and upload it
                again.
              </Alert>
            )}
            {result?.unknownHeaders?.length > 0 && (
              <Alert tone="amber">Ignored columns: {result.unknownHeaders.join(', ')}</Alert>
            )}
            {ready && <Alert tone="green">All rows look correct. Click Import to add them.</Alert>}
            {doImport.isSuccess && (
              <Alert tone="green">
                {doImport.data.imported} employees added
                {doImport.data.created?.departments
                  ? `, ${doImport.data.created.departments} department(s)`
                  : ''}
                {doImport.data.created?.designations
                  ? `, ${doImport.data.created.designations} designation(s)`
                  : ''}
                .{' '}
                <Link to="/employees" className="underline">
                  View employees
                </Link>
                . They can now sign in with the company code and their mobile.
              </Alert>
            )}
          </div>
        </Card>
      </div>
      {result && (
        <Card title="Check results" className="mt-6">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500 uppercase">
                <tr>
                  <th className="py-2 pr-3">Row</th>
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">Mobile</th>
                  <th className="py-2">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.rows.map((r) => (
                  <tr key={r.line} className="align-top">
                    <td className="py-2 pr-3 text-slate-500">{r.line}</td>
                    <td className="py-2 pr-3">{r.fullName || '—'}</td>
                    <td className="py-2 pr-3">{r.mobile || '—'}</td>
                    <td className="py-2">
                      {r.errors.length === 0 ? (
                        <Badge tone="green">OK</Badge>
                      ) : (
                        <ul className="list-disc space-y-0.5 pl-4 text-rose-700">
                          {r.errors.map((e) => (
                            <li key={e}>{e}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
