import { Suspense, lazy } from 'react';

/**
 * Two websites from one codebase. VITE_APP_SURFACE is replaced at build time, so each build contains
 * only its own app: the staff/employee app, or the patient website (VITE_APP_SURFACE=patient).
 */
const Surface =
  import.meta.env.VITE_APP_SURFACE === 'patient'
    ? lazy(() => import('@/patient/PatientApp'))
    : lazy(() => import('./StaffRoot'));

export function Root() {
  return (
    <Suspense fallback={null}>
      <Surface />
    </Suspense>
  );
}
