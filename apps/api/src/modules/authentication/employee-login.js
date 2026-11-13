import { AppError } from '../../core/errors.js';
import { withSystem, withTenant } from '../../core/db.js';
import { recordAudit } from '../audit/index.js';

const SIGN_IN_STATUSES = ['active', 'on_notice'];

/**
 * Employee sign-in with mobile number + SMS OTP (ADR 0008).
 *
 * The first successful sign-in creates an employee-only user account (no email, no password) and links
 * it to the employee record. Accounts that also hold staff roles must sign in with email + password, so
 * an OTP alone never opens an admin account.
 */
export function createEmployeeLogin({ db, otp, authService }) {
  async function findEmployee(company, mobile) {
    const org = await withSystem(db, (trx) =>
      trx('organizations').where({ slug: company, status: 'active' }).first('id', 'name', 'slug'),
    );
    if (!org) return null;
    const employee = await withTenant(db, org.id, (trx) =>
      trx('employees')
        .where({ organization_id: org.id, mobile_e164: mobile })
        .whereIn('employment_status', SIGN_IN_STATUSES)
        .first('id', 'full_name', 'mobile_e164', 'user_id'),
    );
    return employee ? { org, employee } : null;
  }

  return {
    /** Always resolves the same way whether or not the number is registered (no enumeration). */
    async requestOtp({ company, mobile, ip }) {
      const found = await findEmployee(company, mobile);
      if (!found) return {};
      const r = await withTenant(db, found.org.id, (trx) =>
        otp.issue(trx, {
          organizationId: found.org.id,
          employeeId: found.employee.id,
          purpose: 'employee_login',
          mobile: found.employee.mobile_e164,
          ip,
          demo: otp.demoCodeAllowed(found.org.slug, found.employee.mobile_e164),
        }),
      );
      return r.demoCode ? { demoCode: r.demoCode } : {};
    },

    async verifyOtp({ company, mobile, code, meta }) {
      const found = await findEmployee(company, mobile);
      if (!found) {
        throw new AppError(
          400,
          'OTP_INVALID',
          'The code is incorrect or has expired. Request a new code.',
        );
      }
      const { org, employee } = found;

      return otp.verify(
        { organizationId: org.id, employeeId: employee.id, purpose: 'employee_login', code },
        async (trx) => {
          let user;
          if (employee.user_id) {
            user = await trx('users')
              .where({ organization_id: org.id, id: employee.user_id })
              .first();
            const roles = await trx('user_role_assignments')
              .where({ organization_id: org.id, user_id: user.id })
              .pluck('role_key');
            if (roles.some((r) => r !== 'employee')) {
              throw new AppError(
                403,
                'USE_PASSWORD_LOGIN',
                'This person has a staff login. Please sign in with email and password.',
              );
            }
            if (user.status !== 'active') {
              [user] = await trx('users')
                .where({ organization_id: org.id, id: user.id })
                .update({ status: 'active', updated_at: trx.fn.now() })
                .returning('*');
            }
          } else {
            [user] = await trx('users')
              .insert({
                organization_id: org.id,
                email: null,
                password_hash: null,
                full_name: employee.full_name,
                phone_e164: employee.mobile_e164,
              })
              .returning('*');
            await trx('user_role_assignments').insert({
              organization_id: org.id,
              user_id: user.id,
              role_key: 'employee',
              branch_id: null,
            });
            await trx('employees')
              .where({ organization_id: org.id, id: employee.id })
              .update({ user_id: user.id, updated_at: trx.fn.now() });
          }
          await trx('users')
            .where({ organization_id: org.id, id: user.id })
            .update({ last_login_at: trx.fn.now() });
          await recordAudit(trx, {
            organizationId: org.id,
            actorUserId: user.id,
            action: 'auth.employee_login',
            entityType: 'employee',
            entityId: employee.id,
            ip: meta.ip,
            requestId: meta.requestId,
          });
          return authService.startSession(trx, user, meta);
        },
      );
    },
  };
}
