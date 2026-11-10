import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from '@/features/auth/auth-context';
import { LoginPage } from '@/features/auth/LoginPage';
import { ChangePasswordPage } from '@/features/auth/ChangePasswordPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { BranchesPage } from '@/features/branches/BranchesPage';
import { UsersPage } from '@/features/users/UsersPage';
import { AuditPage } from '@/features/audit/AuditPage';
import { Spinner } from '@/components/ui';
import { AppLayout } from './AppLayout';

/** Friendly page for routes the user can't open. The API enforces the same permission. */
function RequirePermission({ permission, children }) {
  const auth = useAuth();
  if (auth.can(permission)) return children;
  return (
    <div className="max-w-md">
      <h1 className="text-xl font-bold text-slate-900">No access</h1>
      <p className="mt-2 text-sm text-slate-600">
        Your role doesn&apos;t include this section. Ask your organization admin if you need access.
      </p>
    </div>
  );
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
  return <AppLayout />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route index element={<DashboardPage />} />
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
