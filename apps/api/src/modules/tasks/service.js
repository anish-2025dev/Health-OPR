import { isOverdue } from './calc.js';
import { notFound, forbidden } from '../../core/errors.js';
import { recordAudit } from '../audit/index.js';

export function presentTask(t, asOfDate = new Date().toISOString().slice(0, 10)) {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    priority: t.priority,
    status: t.status,
    startDate: t.start_date,
    deadline: t.deadline,
    isOverdue: isOverdue(t, asOfDate),
    completedAt: t.completed_at,
    completionNotes: t.completion_notes,
    assignedTo: t.assigned_to_employee_id
      ? {
          id: t.assigned_to_employee_id,
          fullName: t.assigned_to_name,
          employeeNumber: t.assigned_to_number,
        }
      : null,
    assignedBy: t.assigned_by_user_id
      ? {
          id: t.assigned_by_user_id,
          fullName: t.assigned_by_name,
        }
      : null,
    department: t.department_id
      ? {
          id: t.department_id,
          name: t.department_name,
        }
      : null,
    branchId: t.branch_id,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

export function baseTaskQuery(trx, orgId) {
  return trx('tasks as t')
    .leftJoin('employees as e', 'e.id', 't.assigned_to_employee_id')
    .leftJoin('users as u', 'u.id', 't.assigned_by_user_id')
    .leftJoin('departments as d', 'd.id', 't.department_id')
    .where({ 't.organization_id': orgId, 't.is_archived': false })
    .select(
      't.*',
      'e.full_name as assigned_to_name',
      'e.employee_number as assigned_to_number',
      'e.reporting_manager_id',
      'u.full_name as assigned_by_name',
      'd.name as department_name',
    );
}

export async function getTaskById(trx, orgId, taskId) {
  const row = await baseTaskQuery(trx, orgId).where('t.id', taskId).first();
  if (!row) throw notFound('Task not found');
  return row;
}

export async function getTaskWithComments(trx, orgId, taskId) {
  const task = await getTaskById(trx, orgId, taskId);
  const comments = await trx('task_comments as c')
    .leftJoin('users as u', 'u.id', 'c.author_user_id')
    .leftJoin('employees as e', 'e.id', 'c.author_employee_id')
    .where({ 'c.organization_id': orgId, 'c.task_id': taskId })
    .orderBy('c.created_at', 'asc')
    .select(
      'c.id',
      'c.body',
      'c.created_at',
      'u.id as user_id',
      'u.full_name as user_name',
      'e.id as employee_id',
      'e.full_name as employee_name',
    );

  return {
    ...presentTask(task),
    comments: comments.map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: c.created_at,
      author: c.user_id
        ? { type: 'user', id: c.user_id, name: c.user_name }
        : { type: 'employee', id: c.employee_id, name: c.employee_name },
    })),
  };
}

export async function createTask(trx, orgId, data, actor) {
  // If assigning to employee, verify branch/tenant and get department
  let branchId = data.branchId || null;
  let departmentId = data.departmentId || null;

  if (data.assignedToEmployeeId) {
    const emp = await trx('employees')
      .where({ organization_id: orgId, id: data.assignedToEmployeeId })
      .first('id', 'branch_id', 'department_id');
    if (!emp) throw notFound('Assigned employee not found');
    branchId = branchId || emp.branch_id;
    departmentId = departmentId || emp.department_id;
  }

  const [row] = await trx('tasks')
    .insert({
      organization_id: orgId,
      branch_id: branchId,
      department_id: departmentId,
      title: data.title,
      description: data.description || null,
      created_by_user_id: actor.userId || null,
      assigned_by_user_id: actor.userId || null,
      assigned_to_employee_id: data.assignedToEmployeeId || null,
      priority: data.priority || 'medium',
      status: 'pending',
      start_date: data.startDate || null,
      deadline: data.deadline || null,
    })
    .returning('*');

  await recordAudit(trx, {
    organizationId: orgId,
    actorUserId: actor.userId,
    action: 'task.created',
    entityType: 'task',
    entityId: row.id,
    metadata: {
      title: row.title,
      assignedToEmployeeId: row.assigned_to_employee_id,
      priority: row.priority,
      deadline: row.deadline,
    },
  });

  return getTaskById(trx, orgId, row.id);
}

export async function updateTask(trx, orgId, taskId, updates, actor) {
  const current = await getTaskById(trx, orgId, taskId);

  const patch = {};
  if (updates.title !== undefined) patch.title = updates.title;
  if (updates.description !== undefined) patch.description = updates.description;
  if (updates.priority !== undefined) patch.priority = updates.priority;
  if (updates.startDate !== undefined) patch.start_date = updates.startDate;
  if (updates.deadline !== undefined) patch.deadline = updates.deadline;
  if (updates.status !== undefined) {
    patch.status = updates.status;
    if (updates.status === 'completed' && current.status !== 'completed') {
      patch.completed_at = trx.fn.now();
    }
  }
  if (updates.completionNotes !== undefined) patch.completion_notes = updates.completionNotes;
  if (updates.assignedToEmployeeId !== undefined) {
    if (updates.assignedToEmployeeId === null) {
      patch.assigned_to_employee_id = null;
    } else {
      const emp = await trx('employees')
        .where({ organization_id: orgId, id: updates.assignedToEmployeeId })
        .first('id', 'branch_id', 'department_id');
      if (!emp) throw notFound('Assigned employee not found');
      patch.assigned_to_employee_id = emp.id;
      if (!current.department_id) patch.department_id = emp.department_id;
    }
  }

  patch.updated_at = trx.fn.now();

  await trx('tasks').where({ organization_id: orgId, id: taskId }).update(patch);

  await recordAudit(trx, {
    organizationId: orgId,
    actorUserId: actor.userId,
    action: 'task.updated',
    entityType: 'task',
    entityId: taskId,
    metadata: { updatedFields: Object.keys(patch) },
  });

  return getTaskById(trx, orgId, taskId);
}

export async function updateTaskStatus(trx, orgId, taskId, status, notes, actor) {
  const current = await getTaskById(trx, orgId, taskId);

  // If actor is employee, check that they are the assigned employee
  if (actor.employeeId && current.assigned_to_employee_id !== actor.employeeId) {
    throw forbidden('You can only update your own assigned tasks');
  }

  const patch = {
    status,
    updated_at: trx.fn.now(),
  };

  if (notes !== undefined) {
    patch.completion_notes = notes;
  }
  if (status === 'completed') {
    patch.completed_at = trx.fn.now();
  } else if (current.status === 'completed') {
    patch.completed_at = null;
  }

  await trx('tasks').where({ organization_id: orgId, id: taskId }).update(patch);

  await recordAudit(trx, {
    organizationId: orgId,
    actorUserId: actor.userId || null,
    action: 'task.status_updated',
    entityType: 'task',
    entityId: taskId,
    metadata: { status, previousStatus: current.status },
  });

  return getTaskById(trx, orgId, taskId);
}

export async function addTaskComment(trx, orgId, taskId, body, actor) {
  await getTaskById(trx, orgId, taskId);

  const [comment] = await trx('task_comments')
    .insert({
      organization_id: orgId,
      task_id: taskId,
      author_user_id: actor.userId || null,
      author_employee_id: actor.employeeId || null,
      body,
    })
    .returning('*');

  return comment;
}
