import { Router } from 'express';
import { orgStructureRouters } from './org-structure/index.js';
import { employeesRouter } from './hr-employees/index.js';
import { hrDeviceRouter, selfDeviceRouter } from './device/index.js';
import { claimsRouter, selfClaimsRouter } from './hr-claims/index.js';
import {
  hrProfileRequestsRouter,
  selfProfileRequestsRouter,
} from './hr-employees/profile-requests.js';
import { tasksRouter, selfTasksRouter } from './tasks/index.js';
import { shiftRequestsRouter, selfShiftRequestsRouter } from './org-structure/shift-requests.js';
import { attendanceRouter, selfAttendanceRouter } from './hr-attendance/routes.js';
import { leaveRouter, selfLeaveRouter } from './hr-leave/routes.js';
import { messagesRouter, selfMessagesRouter } from './messages/index.js';
import { statutoryRouter } from './hr-statutory/routes.js';
import { payrollRouter, selfPayslipRouter } from './hr-payroll/routes.js';
import { analyticsRouter } from './analytics/index.js';
import { branchesRouter } from './branches/index.js';

/**
 * Suntek-Mgt (HRMS) Domain Router.
 *
 * Encapsulates all Human Resource Management and Workforce Operations modules:
 * - Organization structure (departments, designations, shifts, holidays)
 * - Employee directory, profile updates, and hardware device restrictions
 * - Time and attendance, geofencing, and regularizations
 * - Leave policies, requests, and 2-level approvals
 * - Task assignments, progress tracking, and workload analytics
 * - Employee claims, salary advances, and loans
 * - Shift change and swap requests
 * - Payroll settings, statutory compliance rules, pay runs, and payslips
 * - Internal employee messaging and broadcast notifications
 * - Workforce & owner analytics
 */
export function createMgtRouter({ db, config, authenticate, smsSender, otp, logger }) {
  const router = Router();

  const structure = orgStructureRouters({ db });
  router.use('/departments', authenticate, structure.departments);
  router.use('/designations', authenticate, structure.designations);
  router.use('/shifts', authenticate, structure.shifts);
  router.use('/holidays', authenticate, structure.holidays);

  router.use('/hr/employees', authenticate, employeesRouter({ db }));
  router.use('/hr/employees', authenticate, hrDeviceRouter({ db }));
  router.use('/hr/claims', authenticate, claimsRouter({ db }));
  router.use('/hr/profile-requests', authenticate, hrProfileRequestsRouter({ db }));

  router.use('/tasks', authenticate, tasksRouter({ db }));
  router.use('/shift-requests', authenticate, shiftRequestsRouter({ db }));
  router.use('/attendance', authenticate, attendanceRouter({ db }));
  router.use('/leave', authenticate, leaveRouter({ db }));

  router.use('/me/leave', authenticate, selfLeaveRouter({ db }));
  router.use('/me/payslips', authenticate, selfPayslipRouter({ db }));
  router.use('/me/messages', authenticate, selfMessagesRouter({ db }));
  router.use('/me/tasks', authenticate, selfTasksRouter({ db }));
  router.use('/me/claims', authenticate, selfClaimsRouter({ db }));
  router.use('/me/device', authenticate, selfDeviceRouter({ db }));
  router.use('/me/profile-requests', authenticate, selfProfileRequestsRouter({ db }));
  router.use('/me/shift-requests', authenticate, selfShiftRequestsRouter({ db }));
  router.use('/me', authenticate, selfAttendanceRouter({ db, otp }));

  router.use('/messages', authenticate, messagesRouter({ db, config, sms: smsSender, logger }));
  router.use('/payroll/statutory', authenticate, statutoryRouter({ db }));
  router.use('/payroll', authenticate, payrollRouter({ db }));
  router.use('/analytics', authenticate, analyticsRouter({ db }));
  router.use('/branches', authenticate, branchesRouter({ db }));

  return router;
}
