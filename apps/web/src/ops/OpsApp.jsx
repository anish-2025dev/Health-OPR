import { Navigate, Route, Routes, useLocation } from 'react-router';
import { AuthProvider, useAuth } from '@/features/auth/auth-context';
import { LoginPage } from '@/features/auth/LoginPage';
import { ChangePasswordPage } from '@/features/auth/ChangePasswordPage';
import { InvitePage } from '@/features/auth/InvitePage';
import { BranchesPage } from '@/features/branches/BranchesPage';
import { UsersPage } from '@/features/users/UsersPage';
import { AuditPage } from '@/features/audit/AuditPage';
import {
  PatientDetailPage,
  PatientsPage,
  RegisterPatientPage,
} from '@/features/patients/PatientsPages';
import { PrivacyPage } from '@/features/patients/PrivacyPage';
import { DoctorsPage } from '@/features/clinic/DoctorsPage';
import {
  ClinicDashboardPage,
  QueueDisplayPage,
  ReceptionPage,
  TrackPage,
} from '@/features/clinic/QueuePages';
import { MessagingPage } from '@/features/integrations/MessagingPage';
import { AnalyticsPage } from '@/features/analytics/AnalyticsPage';
import { Spinner } from '@/components/ui';
import { OpsLayout } from './OpsLayout';

function RequirePermission({ permission, allow, children }) {
  const auth = useAuth();
  if (allow ? allow(auth) : auth.can(permission)) return children;
  return (
    <div className="max-w-md">
      <h1 className="text-xl font-bold text-slate-900">No access</h1>
      <p className="mt-2 text-sm text-slate-600">
        Your role doesn&apos;t include this clinical section. Ask your clinic admin if you need
        access.
      </p>
    </div>
  );
}

function RequireAuthBare({ children }) {
  const auth = useAuth();
  if (auth.status === 'loading') return <Spinner />;
  if (auth.status === 'anonymous') return <Navigate to="/login" replace />;
  return children;
}

function RequireAuth() {
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (auth.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (auth.me.user.mustChangePassword) return <ChangePasswordPage forced />;
  return <OpsLayout />;
}

export function OpsAppContent() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite" element={<InvitePage />} />
      <Route path="/track/:code" element={<TrackPage />} />
      <Route
        path="/queue-display/:doctorId"
        element={
          <RequireAuthBare>
            <QueueDisplayPage />
          </RequireAuthBare>
        }
      />
      <Route element={<RequireAuth />}>
        <Route
          index
          element={
            <RequirePermission allow={(a) => a.can('appointments.read') || a.can('queue.manage')}>
              <ClinicDashboardPage />
            </RequirePermission>
          }
        />
        <Route
          path="clinic"
          element={
            <RequirePermission permission="appointments.read">
              <ClinicDashboardPage />
            </RequirePermission>
          }
        />
        <Route
          path="reception"
          element={
            <RequirePermission permission="queue.manage">
              <ReceptionPage />
            </RequirePermission>
          }
        />
        <Route
          path="patients"
          element={
            <RequirePermission permission="patients.read">
              <PatientsPage />
            </RequirePermission>
          }
        />
        <Route
          path="patients/new"
          element={
            <RequirePermission permission="patients.manage">
              <RegisterPatientPage />
            </RequirePermission>
          }
        />
        <Route
          path="patients/:id"
          element={
            <RequirePermission permission="patients.read">
              <PatientDetailPage />
            </RequirePermission>
          }
        />
        <Route
          path="doctors"
          element={
            <RequirePermission permission="appointments.read">
              <DoctorsPage />
            </RequirePermission>
          }
        />
        <Route
          path="privacy"
          element={
            <RequirePermission permission="patients.manage">
              <PrivacyPage />
            </RequirePermission>
          }
        />
        <Route
          path="messaging"
          element={
            <RequirePermission permission="organization.manage">
              <MessagingPage />
            </RequirePermission>
          }
        />
        <Route
          path="analytics"
          element={
            <RequirePermission permission="appointments.read">
              <AnalyticsPage />
            </RequirePermission>
          }
        />
        <Route
          path="branches"
          element={
            <RequirePermission permission="branches.read">
              <BranchesPage />
            </RequirePermission>
          }
        />
        <Route
          path="users"
          element={
            <RequirePermission permission="users.read">
              <UsersPage />
            </RequirePermission>
          }
        />
        <Route
          path="audit"
          element={
            <RequirePermission permission="audit.read">
              <AuditPage />
            </RequirePermission>
          }
        />
        <Route path="account/password" element={<ChangePasswordPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function OpsApp() {
  return (
    <AuthProvider>
      <OpsAppContent />
    </AuthProvider>
  );
}
