import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { isUuid, withTenant } from '../../core/db.js';
import { AppError, forbidden, notFound } from '../../core/errors.js';
import { auditContext, recordAudit } from '../audit/index.js';
import { PERMISSIONS } from '../staff-access/permissions.js';
import { SmsNotConfiguredError } from '../../integrations/sms/index.js';

const P = PERMISSIONS;
const CATEGORIES = ['payroll', 'performance', 'leave', 'attendance', 'general'];
const ACTIVE = ['active', 'on_notice'];

/** Inserts a message and its recipients in the caller's transaction. */
export async function createEmployeeMessage(trx, org, m) {
  const [row] = await trx('employee_messages')
    .insert({
      organization_id: org,
      sender_user_id: m.senderUserId ?? null,
      sender_label: m.senderLabel,
      category: m.category,
      title: m.title,
      body: m.body,
      audience_type: m.audienceType,
      audience_label: m.audienceLabel,
      sms_alert: Boolean(m.smsAlert),
    })
    .returning('id');
  if (m.employeeIds.length) {
    await trx('employee_message_recipients').insert(
      m.employeeIds.map((id) => ({ organization_id: org, message_id: row.id, employee_id: id })),
    );
  }
  return row.id;
}

/**
 * Who may send what:
 * - HR (employees.manage): any category, to anyone in their branch scope.
 * - Payroll (payroll.manage without employees.manage): payroll messages, to anyone in scope.
 * - Reporting managers: non-payroll messages to their own direct reports only.
 */
function senderRights(auth) {
  const hr = auth.permissions.has(P.EMPLOYEES_MANAGE);
  const payroll = auth.permissions.has(P.PAYROLL_MANAGE);
  const manager = Boolean(auth.employee?.isManager);
  return {
    canSend: hr || payroll || manager,
    wide: hr || payroll,
    categories: hr
      ? CATEGORIES
      : [
          ...(payroll ? ['payroll'] : []),
          ...(manager ? CATEGORIES.filter((c) => c !== 'payroll') : []),
        ],
  };
}

const composeSchema = z
  .object({
    category: z.enum(CATEGORIES),
    title: z.string().trim().min(3).max(150),
    body: z.string().trim().min(1).max(4000),
    audience: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('employees'),
        employeeIds: z.array(z.string().uuid()).min(1).max(500),
      }),
      z.object({ type: z.literal('team') }),
      z.object({ type: z.literal('department'), departmentId: z.string().uuid() }),
      z.object({ type: z.literal('branch'), branchId: z.string().uuid() }),
      z.object({ type: z.literal('all') }),
    ]),
    smsAlert: z.boolean().default(false),
  })
  .strict();

export function messagesRouter({ db, config, sms, logger }) {
  const router = Router();
  const alertsAvailable = () =>
    sms.provider !== 'none' &&
    Boolean(config.MSG91_MESSAGE_ALERT_TEMPLATE_ID || sms.provider !== 'msg91');

  router.get('/options', async (req, res) => {
    const rights = senderRights(req.auth);
    if (!rights.canSend) throw forbidden();
    const org = req.auth.organizationId;
    const out = await withTenant(db, org, async (trx) => {
      const scope = (q, col) =>
        req.auth.branchIds === null ? q : q.whereIn(col, req.auth.branchIds);
      const team = req.auth.employee
        ? await trx('employees')
            .where({ organization_id: org, reporting_manager_id: req.auth.employee.id })
            .whereIn('employment_status', ACTIVE)
            .orderBy('full_name')
            .select('id', 'full_name', 'employee_number')
        : [];
      return {
        categories: rights.categories,
        wide: rights.wide,
        team: team.map((e) => ({
          id: e.id,
          fullName: e.full_name,
          employeeNumber: e.employee_number,
        })),
        departments: rights.wide
          ? await trx('departments')
              .where({ organization_id: org, status: 'active' })
              .orderBy('name')
              .select('id', 'name')
          : [],
        branches: rights.wide
          ? await scope(trx('branches').where({ organization_id: org, status: 'active' }), 'id')
              .orderBy('name')
              .select('id', 'name')
          : [],
        smsAlertAvailable: alertsAvailable(),
      };
    });
    res.json(out);
  });

  router.post('/', async (req, res) => {
    const body = validate(composeSchema, req.body);
    const rights = senderRights(req.auth);
    if (!rights.canSend) throw forbidden();
    if (!rights.categories.includes(body.category))
      throw forbidden('You cannot send this kind of message');
    const a = body.audience;
    if (!rights.wide && !['employees', 'team'].includes(a.type)) {
      throw forbidden('Managers can message only their own team');
    }
    if (body.smsAlert && !alertsAvailable()) {
      throw new AppError(409, 'SMS_ALERT_UNAVAILABLE', 'SMS alerts are not set up');
    }
    const org = req.auth.organizationId;
    const result = await withTenant(db, org, async (trx) => {
      const q = trx('employees')
        .where({ organization_id: org })
        .whereIn('employment_status', ACTIVE);
      if (req.auth.branchIds !== null) q.whereIn('branch_id', req.auth.branchIds);
      let label;
      if (a.type === 'team') {
        if (!req.auth.employee) throw forbidden('You have no team');
        q.where('reporting_manager_id', req.auth.employee.id);
        label = 'My team';
      } else if (a.type === 'employees') {
        q.whereIn('id', a.employeeIds);
        if (!rights.wide) {
          if (!req.auth.employee) throw forbidden();
          q.where('reporting_manager_id', req.auth.employee.id);
        }
      } else if (a.type === 'department') {
        const d = await trx('departments')
          .where({ organization_id: org, id: a.departmentId })
          .first('name');
        if (!d) throw new AppError(400, 'VALIDATION_ERROR', 'Unknown department');
        q.where('department_id', a.departmentId);
        label = `Department: ${d.name}`;
      } else if (a.type === 'branch') {
        const b = await trx('branches')
          .where({ organization_id: org, id: a.branchId })
          .first('name');
        if (!b) throw new AppError(400, 'VALIDATION_ERROR', 'Unknown branch');
        q.where('branch_id', a.branchId);
        label = `Branch: ${b.name}`;
      } else {
        label = 'All employees';
      }
      const recipients = await q.select('id', 'full_name', 'mobile_e164');
      if (a.type === 'employees') {
        if (recipients.length !== new Set(a.employeeIds).size) {
          throw forbidden('Some selected people are not in your team or not active');
        }
        label =
          recipients.length === 1 ? recipients[0].full_name : `${recipients.length} employees`;
      }
      if (!recipients.length)
        throw new AppError(400, 'NO_RECIPIENTS', 'Nobody matches this audience');
      const sender = await trx('users')
        .where({ organization_id: org, id: req.auth.userId })
        .first('full_name');
      const id = await createEmployeeMessage(trx, org, {
        senderUserId: req.auth.userId,
        senderLabel: sender?.full_name ?? 'HR',
        category: body.category,
        title: body.title,
        body: body.body,
        audienceType: a.type,
        audienceLabel: label,
        employeeIds: recipients.map((r) => r.id),
        smsAlert: body.smsAlert,
      });
      await recordAudit(trx, {
        ...auditContext(req),
        action: 'employee_message.sent',
        entityType: 'employee_message',
        entityId: id,
        metadata: {
          category: body.category,
          audience: a.type,
          recipients: recipients.length,
          smsAlert: body.smsAlert,
        },
      });
      const orgRow = await trx('organizations').where({ id: org }).first('name');
      return { id, recipients, orgName: orgRow.name };
    });

    if (body.smsAlert) {
      // The SMS says only that a message is waiting; the content stays in the app.
      const link = `${config.FRONTEND_URL.replace(/\/$/, '')}/my-messages`;
      const statuses = {};
      for (const r of result.recipients) {
        try {
          await sms.sendMessageAlert({
            to: r.mobile_e164,
            variables: { org: result.orgName, link },
          });
          statuses[r.id] = 'sent';
        } catch (err) {
          statuses[r.id] = err instanceof SmsNotConfiguredError ? 'skipped' : 'failed';
          if (statuses[r.id] === 'failed')
            logger?.warn({ err: err.message }, 'message alert sms failed');
        }
      }
      await withTenant(db, req.auth.organizationId, async (trx) => {
        for (const [employeeId, status] of Object.entries(statuses)) {
          await trx('employee_message_recipients')
            .where({ message_id: result.id, employee_id: employeeId })
            .update({ sms_status: status });
        }
      });
    }
    res.status(201).json({ id: result.id, recipients: result.recipients.length });
  });

  router.get('/sent', async (req, res) => {
    const rights = senderRights(req.auth);
    if (!rights.canSend) throw forbidden();
    const org = req.auth.organizationId;
    const rows = await withTenant(db, org, (trx) => {
      const q = trx('employee_messages as m')
        .leftJoin('employee_message_recipients as r', 'r.message_id', 'm.id')
        .where('m.organization_id', org)
        .groupBy('m.id')
        .orderBy('m.created_at', 'desc')
        .limit(100)
        .select(
          'm.*',
          trx.raw('count(r.employee_id)::int AS recipients'),
          trx.raw('count(r.read_at)::int AS read'),
        );
      // HR sees every message; others see what they sent.
      if (!req.auth.permissions.has(P.EMPLOYEES_MANAGE))
        q.where('m.sender_user_id', req.auth.userId);
      return q;
    });
    res.json({
      data: rows.map((m) => ({
        id: m.id,
        category: m.category,
        title: m.title,
        body: m.body,
        audience: m.audience_label,
        sender: m.sender_label,
        smsAlert: m.sms_alert,
        recipients: m.recipients,
        read: m.read,
        createdAt: m.created_at,
      })),
    });
  });

  return router;
}

/** The signed-in employee's inbox (via their employee link). */
export function selfMessagesRouter({ db }) {
  const router = Router();
  const employeeId = (req) => {
    if (!req.auth.employee) throw notFound('No employee profile is linked to this login');
    return req.auth.employee.id;
  };

  router.get('/', async (req, res) => {
    const org = req.auth.organizationId;
    const me = employeeId(req);
    const rows = await withTenant(db, org, (trx) =>
      trx('employee_message_recipients as r')
        .join('employee_messages as m', 'm.id', 'r.message_id')
        .where({ 'r.organization_id': org, 'r.employee_id': me })
        .orderBy('m.created_at', 'desc')
        .limit(100)
        .select(
          'm.id',
          'm.category',
          'm.title',
          'm.body',
          'm.sender_label',
          'm.created_at',
          'r.read_at',
        ),
    );
    res.json({
      unread: rows.filter((r) => !r.read_at).length,
      data: rows.map((m) => ({
        id: m.id,
        category: m.category,
        title: m.title,
        body: m.body,
        sender: m.sender_label,
        createdAt: m.created_at,
        readAt: m.read_at,
      })),
    });
  });

  router.post('/:id/read', async (req, res) => {
    const org = req.auth.organizationId;
    const me = employeeId(req);
    if (!isUuid(req.params.id)) throw notFound('Message not found');
    const n = await withTenant(db, org, (trx) =>
      trx('employee_message_recipients')
        .where({ organization_id: org, employee_id: me, message_id: req.params.id })
        .whereNull('read_at')
        .update({ read_at: trx.fn.now() }),
    );
    res.json({ updated: n });
  });

  router.post('/read-all', async (req, res) => {
    const org = req.auth.organizationId;
    const me = employeeId(req);
    const n = await withTenant(db, org, (trx) =>
      trx('employee_message_recipients')
        .where({ organization_id: org, employee_id: me })
        .whereNull('read_at')
        .update({ read_at: trx.fn.now() }),
    );
    res.json({ updated: n });
  });

  return router;
}
