import { forbidden, unauthorized } from '../../core/errors.js';

/**
 * Permission catalog. Later phases add permissions here (patients.*, attendance.*, payroll.*…) and grant
 * them to roles below. The backend is the only place authorization is decided.
 */
export const PERMISSIONS = Object.freeze({
  ORGANIZATION_MANAGE: 'organization.manage',
  BRANCHES_READ: 'branches.read',
  BRANCHES_MANAGE: 'branches.manage',
  USERS_READ: 'users.read',
  USERS_MANAGE: 'users.manage',
  AUDIT_READ: 'audit.read',
  // Phase 8: organization structure and employees
  ORG_STRUCTURE_MANAGE: 'org_structure.manage', // departments, designations, shifts, holidays
  HOLIDAYS_READ: 'holidays.read',
  EMPLOYEES_READ: 'employees.read',
  EMPLOYEES_MANAGE: 'employees.manage',
});

const ALL = Object.values(PERMISSIONS);
const P = PERMISSIONS;

/**
 * System roles from the project spec. HR/payroll roles get no patient permissions, and clinic roles get
 * no salary permissions; those permissions arrive in later phases and must respect this split.
 */
export const ROLES = Object.freeze({
  organization_owner: { label: 'Organization owner', permissions: ALL },
  organization_admin: { label: 'Organization admin', permissions: ALL },
  clinic_manager: {
    label: 'Clinic manager',
    permissions: [P.BRANCHES_READ, P.USERS_READ, P.HOLIDAYS_READ, P.EMPLOYEES_READ],
  },
  hr_manager: {
    label: 'HR manager',
    permissions: [
      P.BRANCHES_READ,
      P.USERS_READ,
      P.HOLIDAYS_READ,
      P.ORG_STRUCTURE_MANAGE,
      P.EMPLOYEES_READ,
      P.EMPLOYEES_MANAGE,
    ],
  },
  payroll_manager: {
    label: 'Payroll manager',
    permissions: [P.BRANCHES_READ, P.HOLIDAYS_READ, P.EMPLOYEES_READ],
  },
  // Team view (direct reports) arrives with attendance in Phase 9a.
  department_manager: {
    label: 'Department manager',
    permissions: [P.BRANCHES_READ, P.HOLIDAYS_READ],
  },
  // Clinical/front-desk roles: no employee records (spec: no salary/PF/ESI access by default).
  receptionist: { label: 'Receptionist', permissions: [P.BRANCHES_READ, P.HOLIDAYS_READ] },
  doctor: { label: 'Doctor', permissions: [P.BRANCHES_READ, P.HOLIDAYS_READ] },
  nurse: { label: 'Nurse', permissions: [P.BRANCHES_READ, P.HOLIDAYS_READ] },
  employee: { label: 'Employee', permissions: [P.HOLIDAYS_READ] },
});

export const ROLE_KEYS = Object.freeze(Object.keys(ROLES));

/** Roles only an organization owner may grant or revoke (prevents admins escalating to owner). */
export const OWNER_ONLY_ROLES = Object.freeze(['organization_owner']);

export function permissionsFor(roleKeys) {
  const set = new Set();
  for (const key of roleKeys) for (const p of ROLES[key]?.permissions ?? []) set.add(p);
  return set;
}

export function canAssignRole(actorRoleKeys, roleKey) {
  if (!ROLES[roleKey]) return false;
  if (OWNER_ONLY_ROLES.includes(roleKey)) return actorRoleKeys.includes('organization_owner');
  return true;
}

/** Express middleware: requires an authenticated user holding `permission`. */
export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.auth) return next(unauthorized());
    if (!req.auth.permissions.has(permission)) return next(forbidden());
    next();
  };
}
