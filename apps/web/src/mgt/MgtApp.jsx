import { Navigate, Route, Routes, useLocation } from 'react-router';
import { AuthProvider, useAuth } from '@/features/auth/auth-context';
import { LoginPage } from '@/features/auth/LoginPage';
import { EmployeeLoginPage } from '@/features/auth/EmployeeLoginPage';
import { ChangePasswordPage } from '@/features/auth/ChangePasswordPage';
import { InvitePage } from '@/features/auth/InvitePage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { BranchesPage } from '@/features/branches/BranchesPage';
import { UsersPage } from '@/features/users/UsersPage';
import { AuditPage } from '@/features/audit/AuditPage';
import { EmployeesPage } from '@/features/employees/EmployeesPage';
import { EmployeeFormPage } from '@/features/employees/EmployeeFormPage';
import { ImportEmployeesPage } from '@/features/employees/ImportEmployeesPage';
import { HolidaysPage } from '@/features/org-structure/HolidaysPage';
import { CompanySetupPage } from '@/features/org-structure/CompanySetupPage';
import { MyAttendancePage } from '@/features/attendance/MyAttendancePage';
import { MyLeavePage } from '@/features/leave/MyLeavePage';
import { LeaveAdminPage } from '@/features/leave/LeaveAdminPage';
import {
  MyPayslipsPage,
  PayrollRunPage,
  PayrollRunsPage,
  PayrollSetupPage,
  SalariesPage,
} from '@/features/payroll/PayrollPages';
import { StatutoryPage } from '@/features/payroll/StatutoryPage';
import {
  AttendanceDashboardPage,
  AttendanceRegisterPage,
  AttendanceSettingsPage,
  EmployeeAttendancePage,
  RegularizationsPage,
  TeamAttendancePage,
} from '@/features/attendance/AdminAttendancePages';
import { MessagesPage, MyMessagesPage } from '@/features/messages/MessagesPages';
import { AnalyticsPage } from '@/features/analytics/AnalyticsPage';
import { Spinner } from '@/components/ui';
import { MgtLayout } from './MgtLayout';

function RequirePermission({ permission, allow, children }) {
  const auth = useAuth();
  if (allow ? allow(auth) : auth.can(permission)) return children;
  return (
    <div className="max-w-md">
      <h1 className="text-xl font-bold text-slate-900">No access</h1>
      <p className="mt-2 text-sm text-slate-600">
        Your role doesn&apos;t include this section. Ask your organization admin if you need access.
      </p>
    </div>
  );
}

function HomeRoute() {
  const { me } = useAuth();
  const employeeOnly = me.roles.every((r) => r.role === 'employee');
  if (employeeOnly && me.employee) return <Navigate to="/my-attendance" replace />;
  return <DashboardPage />;
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
  return <MgtLayout />;
}

export function MgtAppContent() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/employee-login" element={<EmployeeLoginPage />} />
      <Route path="/invite" element={<InvitePage />} />
      <Route element={<RequireAuth />}>
        <Route index element={<HomeRoute />} />
        <Route
          path="my-attendance"
          element={
            <RequirePermission allow={(a) => Boolean(a.me.employee)}>
              <MyAttendancePage />
            </RequirePermission>
          }
        />
        <Route
          path="attendance"
          element={
            <RequirePermission permission="attendance.read">
              <AttendanceDashboardPage />
            </RequirePermission>
          }
        />
        <Route
          path="attendance/register"
          element={
            <RequirePermission permission="attendance.read">
              <AttendanceRegisterPage />
            </RequirePermission>
          }
        />
        <Route
          path="attendance/settings"
          element={
            <RequirePermission permission="attendance.read">
              <AttendanceSettingsPage />
            </RequirePermission>
          }
        />
        <Route
          path="attendance/regularizations"
          element={
            <RequirePermission permission="attendance.read">
              <RegularizationsPage />
            </RequirePermission>
          }
        />
        <Route
          path="attendance/team"
          element={
            <RequirePermission allow={(a) => Boolean(a.me.employee?.isManager)}>
              <TeamAttendancePage />
            </RequirePermission>
          }
        />
        <Route
          path="attendance/employees/:id"
          element={
            <RequirePermission permission="attendance.read">
              <EmployeeAttendancePage />
            </RequirePermission>
          }
        />
        <Route
          path="my-leave"
          element={
            <RequirePermission allow={(a) => Boolean(a.me.employee)}>
              <MyLeavePage />
            </RequirePermission>
          }
        />
        <Route
          path="leave"
          element={
            <RequirePermission
              allow={(a) => a.can('leave.read') || Boolean(a.me.employee?.isManager)}
            >
              <LeaveAdminPage />
            </RequirePermission>
          }
        />
        <Route
          path="my-payslips"
          element={
            <RequirePermission allow={(a) => Boolean(a.me.employee)}>
              <MyPayslipsPage />
            </RequirePermission>
          }
        />
        <Route
          path="payroll"
          element={
            <RequirePermission permission="payroll.read">
              <PayrollRunsPage />
            </RequirePermission>
          }
        />
        <Route
          path="payroll/setup"
          element={
            <RequirePermission permission="payroll.manage">
              <PayrollSetupPage />
            </RequirePermission>
          }
        />
        <Route
          path="payroll/runs"
          element={
            <RequirePermission permission="payroll.read">
              <PayrollRunsPage />
            </RequirePermission>
          }
        />
        <Route
          path="payroll/runs/:id"
          element={
            <RequirePermission permission="payroll.read">
              <PayrollRunPage />
            </RequirePermission>
          }
        />
        <Route
          path="payroll/salaries"
          element={
            <RequirePermission permission="payroll.manage">
              <SalariesPage />
            </RequirePermission>
          }
        />
        <Route
          path="payroll/statutory"
          element={
            <RequirePermission permission="payroll.manage">
              <StatutoryPage />
            </RequirePermission>
          }
        />
        <Route
          path="my-messages"
          element={
            <RequirePermission allow={(a) => Boolean(a.me.employee)}>
              <MyMessagesPage />
            </RequirePermission>
          }
        />
        <Route
          path="messages"
          element={
            <RequirePermission
              allow={(a) =>
                a.can('employees.manage') ||
                a.can('payroll.manage') ||
                Boolean(a.me.employee?.isManager)
              }
            >
              <MessagesPage />
            </RequirePermission>
          }
        />
        <Route
          path="employees"
          element={
            <RequirePermission permission="employees.read">
              <EmployeesPage />
            </RequirePermission>
          }
        />
        <Route
          path="employees/new"
          element={
            <RequirePermission permission="employees.manage">
              <EmployeeFormPage />
            </RequirePermission>
          }
        />
        <Route
          path="employees/import"
          element={
            <RequirePermission permission="employees.manage">
              <ImportEmployeesPage />
            </RequirePermission>
          }
        />
        <Route
          path="employees/:id"
          element={
            <RequirePermission permission="employees.manage">
              <EmployeeFormPage />
            </RequirePermission>
          }
        />
        <Route
          path="holidays"
          element={
            <RequirePermission permission="holidays.read">
              <HolidaysPage />
            </RequirePermission>
          }
        />
        <Route
          path="company-setup"
          element={
            <RequirePermission permission="org_structure.manage">
              <CompanySetupPage />
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
          path="analytics"
          element={
            <RequirePermission
              allow={(a) =>
                a.can('organization.manage') ||
                (a.can('employees.read') && a.can('attendance.read'))
              }
            >
              <AnalyticsPage />
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

export default function MgtApp() {
  return (
    <AuthProvider>
      <MgtAppContent />
    </AuthProvider>
  );
}
