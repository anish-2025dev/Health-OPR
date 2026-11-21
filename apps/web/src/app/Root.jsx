import { Suspense, lazy } from 'react';

/**
 * Multi-product surface selection:
 * - 'mgt': Suntek-Mgt (Human Resource Management System)
 * - 'ops': Suntek-ops (Hospital Management and Operations)
 * - 'patient': Standalone Public Patient Portal
 * - 'platform': Operator Control Plane Console
 * - 'staff' (default): Full legacy combined portal for backward compatibility
 */
function getSurface() {
  const surface = import.meta.env.VITE_APP_SURFACE;
  switch (surface) {
    case 'mgt':
      return lazy(() => import('@/mgt/MgtApp'));
    case 'ops':
      return lazy(() => import('@/ops/OpsApp'));
    case 'patient':
      return lazy(() => import('@/patient/PatientApp'));
    case 'platform':
      return lazy(() => import('@/platform/PlatformApp'));
    case 'staff':
    default:
      return lazy(() => import('./StaffRoot'));
  }
}

const Surface = getSurface();

export function Root() {
  return (
    <Suspense fallback={null}>
      <Surface />
    </Suspense>
  );
}
