import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { isUuid, withTenant } from '../../core/db.js';
import { notFound, forbidden } from '../../core/errors.js';
import { recordAudit } from '../audit/index.js';
import { PERMISSIONS } from '../staff-access/permissions.js';
import {
  baseTaskQuery,
  createTask,
  getTaskById,
  getTaskWithComments,
  presentTask,
  updateTask,
  updateTaskStatus,
  addTaskComment,
} from './service.js';
import { summarizeTasks, summarizeWorkloads } from './calc.js';

const P = PERMISSIONS;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const STATUSES = ['pending', 'in_progress', 'on_hold', 'completed', 'cancelled'];

const createTaskSchema = z
  .object({
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().max(4000).optional(),
    assignedToEmployeeId: z.string().uuid().optional(),
    branchId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    priority: z.enum(PRIORITIES).default('medium'),
    startDate: DATE.optional(),
    deadline: DATE.optional(),
  })
  .strict();

const updateTaskSchema = z
  .object({
    title: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    assignedToEmployeeId: z.string().uuid().nullable().optional(),
    priority: z.enum(PRIORITIES).optional(),
    status: z.enum(STATUSES).optional(),
    startDate: DATE.nullable().optional(),
    deadline: DATE.nullable().optional(),
    completionNotes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const updateStatusSchema = z
  .object({
    status: z.enum(['pending', 'in_progress', 'on_hold', 'completed']),
    completionNotes: z.string().trim().max(2000).optional(),
  })
  .strict();

const commentSchema = z
  .object({
    body: z.string().trim().min(1).max(2000),
  })
  .strict();

const listQuerySchema = z.object({
  status: z.enum([...STATUSES, 'all']).default('all'),
  priority: z.enum([...PRIORITIES, 'all']).default('all'),
  assignedToEmployeeId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  overdue: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function tasksRouter({ db }) {
  const router = Router();

  // Management / Team Leader task list
  router.get('/', async (req, res) => {
    const hasOrgAccess = req.auth.permissions.has(P.TASKS_READ);
    const isManager = Boolean(req.auth.employee?.isManager);
    if (!hasOrgAccess && !isManager) throw forbidden();

    const q = validate(listQuerySchema, req.query);
    const orgId = req.auth.organizationId;
    const today = new Date().toISOString().slice(0, 10);

    const result = await withTenant(db, orgId, async (trx) => {
      let query = baseTaskQuery(trx, orgId);

      // Scoping: If manager without org-wide TASKS_READ, restrict to their team
      if (!hasOrgAccess && isManager) {
        query = query.where((b) =>
          b
            .where('e.reporting_manager_id', req.auth.employee.id)
            .orWhere('t.created_by_user_id', req.auth.userId),
        );
      }

      if (req.auth.branchIds !== null) {
        query = query.where((b) =>
          b.whereNull('t.branch_id').orWhereIn('t.branch_id', req.auth.branchIds),
        );
      }

      if (q.status !== 'all') {
        query = query.where('t.status', q.status);
      }
      if (q.priority !== 'all') {
        query = query.where('t.priority', q.priority);
      }
      if (q.assignedToEmployeeId) {
        query = query.where('t.assigned_to_employee_id', q.assignedToEmployeeId);
      }
      if (q.departmentId) {
        query = query.where('t.department_id', q.departmentId);
      }
      if (q.branchId) {
        query = query.where('t.branch_id', q.branchId);
      }
      if (q.overdue === 'true') {
        query = query
          .whereNotIn('t.status', ['completed', 'cancelled'])
          .where('t.deadline', '<', today);
      } else if (q.overdue === 'false') {
        query = query.where((b) => b.whereNull('t.deadline').orWhere('t.deadline', '>=', today));
      }
      if (q.q) {
        query = query.where((b) =>
          b.whereILike('t.title', `%${q.q}%`).orWhereILike('t.description', `%${q.q}%`),
        );
      }

      const countResult = await query.clone().clearSelect().count({ total: '*' }).first();
      const total = Number(countResult?.total ?? 0);

      const rows = await query.orderBy('t.created_at', 'desc').limit(q.limit).offset(q.offset);

      return {
        total,
        data: rows.map((r) => presentTask(r, today)),
      };
    });

    res.json(result);
  });

  // Task analytics summary
  router.get('/analytics', async (req, res) => {
    const hasOrgAccess = req.auth.permissions.has(P.TASKS_READ);
    const isManager = Boolean(req.auth.employee?.isManager);
    if (!hasOrgAccess && !isManager) throw forbidden();

    const orgId = req.auth.organizationId;
    const today = new Date().toISOString().slice(0, 10);

    const stats = await withTenant(db, orgId, async (trx) => {
      let query = baseTaskQuery(trx, orgId);
      if (!hasOrgAccess && isManager) {
        query = query.where('e.reporting_manager_id', req.auth.employee.id);
      }
      if (req.auth.branchIds !== null) {
        query = query.whereIn('t.branch_id', req.auth.branchIds);
      }
      const tasks = await query;
      return {
        summary: summarizeTasks(tasks, today),
        workloads: summarizeWorkloads(tasks, today),
      };
    });

    res.json(stats);
  });

  // Create & Assign task
  router.post('/', async (req, res) => {
    const hasPerm = req.auth.permissions.has(P.TASKS_MANAGE);
    const isManager = Boolean(req.auth.employee?.isManager);
    if (!hasPerm && !isManager) throw forbidden('You do not have permission to assign tasks');

    const body = validate(createTaskSchema, req.body);
    const orgId = req.auth.organizationId;

    const task = await withTenant(db, orgId, async (trx) => {
      // If manager without TASKS_MANAGE, check assigned employee reports to manager
      if (!hasPerm && isManager && body.assignedToEmployeeId) {
        const target = await trx('employees')
          .where({ organization_id: orgId, id: body.assignedToEmployeeId })
          .first('reporting_manager_id');
        if (!target || target.reporting_manager_id !== req.auth.employee.id) {
          throw forbidden('You can only assign tasks to your team members');
        }
      }

      return createTask(trx, orgId, body, {
        userId: req.auth.userId,
        employeeId: req.auth.employee?.id,
      });
    });

    res.status(201).json(presentTask(task));
  });

  // Get task with comments
  router.get('/:id', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const orgId = req.auth.organizationId;
    const task = await withTenant(db, orgId, (trx) =>
      getTaskWithComments(trx, orgId, req.params.id),
    );
    res.json(task);
  });

  // Update task
  router.patch('/:id', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const hasPerm = req.auth.permissions.has(P.TASKS_MANAGE);
    const isManager = Boolean(req.auth.employee?.isManager);
    if (!hasPerm && !isManager) throw forbidden();

    const body = validate(updateTaskSchema, req.body);
    const orgId = req.auth.organizationId;

    const task = await withTenant(db, orgId, async (trx) => {
      return updateTask(trx, orgId, req.params.id, body, {
        userId: req.auth.userId,
      });
    });

    res.json(presentTask(task));
  });

  // Archive / Delete task
  router.delete('/:id', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const hasPerm = req.auth.permissions.has(P.TASKS_MANAGE);
    const isManager = Boolean(req.auth.employee?.isManager);
    if (!hasPerm && !isManager) throw forbidden();

    const orgId = req.auth.organizationId;
    await withTenant(db, orgId, async (trx) => {
      const task = await getTaskById(trx, orgId, req.params.id);
      await trx('tasks')
        .where({ organization_id: orgId, id: req.params.id })
        .update({ is_archived: true, updated_at: trx.fn.now() });

      await recordAudit(trx, {
        organizationId: orgId,
        actorUserId: req.auth.userId,
        action: 'task.archived',
        entityType: 'task',
        entityId: task.id,
      });
    });

    res.json({ success: true });
  });

  // Add comment
  router.post('/:id/comments', async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body = validate(commentSchema, req.body);
    const orgId = req.auth.organizationId;

    const comment = await withTenant(db, orgId, async (trx) => {
      return addTaskComment(trx, orgId, req.params.id, body.body, {
        userId: req.auth.userId,
        employeeId: req.auth.employee?.id,
      });
    });

    res.status(201).json(comment);
  });

  return router;
}

/**
 * Routes for normal employee self-service task dashboard (§4.2, §4.3).
 */
export function selfTasksRouter({ db }) {
  const router = Router();

  const requireEmployee = (req) => {
    if (!req.auth.employee) throw notFound('No employee profile linked to this login');
    return req.auth.employee.id;
  };

  // Employee task list
  router.get('/', async (req, res) => {
    const me = requireEmployee(req);
    const orgId = req.auth.organizationId;
    const today = new Date().toISOString().slice(0, 10);
    const q = validate(
      z.object({
        status: z.enum([...STATUSES, 'all']).default('all'),
      }),
      req.query,
    );

    const rows = await withTenant(db, orgId, async (trx) => {
      let query = baseTaskQuery(trx, orgId).where('t.assigned_to_employee_id', me);
      if (q.status !== 'all') {
        query = query.where('t.status', q.status);
      }
      return query.orderBy('t.created_at', 'desc');
    });

    const tasks = rows.map((r) => presentTask(r, today));
    res.json({
      summary: summarizeTasks(rows, today),
      data: tasks,
    });
  });

  // Employee update status
  router.patch('/:id/status', async (req, res) => {
    const me = requireEmployee(req);
    if (!isUuid(req.params.id)) throw notFound();
    const body = validate(updateStatusSchema, req.body);
    const orgId = req.auth.organizationId;

    const task = await withTenant(db, orgId, async (trx) => {
      return updateTaskStatus(trx, orgId, req.params.id, body.status, body.completionNotes, {
        userId: req.auth.userId,
        employeeId: me,
      });
    });

    res.json(presentTask(task));
  });

  // Employee add comment / progress update
  router.post('/:id/comments', async (req, res) => {
    const me = requireEmployee(req);
    if (!isUuid(req.params.id)) throw notFound();
    const body = validate(commentSchema, req.body);
    const orgId = req.auth.organizationId;

    const comment = await withTenant(db, orgId, async (trx) => {
      return addTaskComment(trx, orgId, req.params.id, body.body, {
        userId: req.auth.userId,
        employeeId: me,
      });
    });

    res.status(201).json(comment);
  });

  return router;
}
