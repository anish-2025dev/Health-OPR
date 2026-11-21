/**
 * Pure calculation functions for Task Management.
 */

/**
 * Checks if a task is overdue as of `asOfDate` ('YYYY-MM-DD').
 * A task is overdue if status is not 'completed' or 'cancelled', and deadline < asOfDate.
 */
export function isOverdue(task, asOfDate) {
  if (!task.deadline) return false;
  if (task.status === 'completed' || task.status === 'cancelled') return false;
  return String(task.deadline).slice(0, 10) < asOfDate;
}

/**
 * Computes summary statistics from a list of tasks.
 */
export function summarizeTasks(tasks, asOfDate = new Date().toISOString().slice(0, 10)) {
  const summary = {
    total: tasks.length,
    pending: 0,
    inProgress: 0,
    onHold: 0,
    completed: 0,
    cancelled: 0,
    overdue: 0,
    byPriority: {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    },
  };

  for (const t of tasks) {
    if (t.status === 'pending') summary.pending += 1;
    else if (t.status === 'in_progress') summary.inProgress += 1;
    else if (t.status === 'on_hold') summary.onHold += 1;
    else if (t.status === 'completed') summary.completed += 1;
    else if (t.status === 'cancelled') summary.cancelled += 1;

    if (t.priority && summary.byPriority[t.priority] !== undefined) {
      summary.byPriority[t.priority] += 1;
    }

    if (isOverdue(t, asOfDate)) {
      summary.overdue += 1;
    }
  }

  return summary;
}

/**
 * Computes workload by employee.
 */
export function summarizeWorkloads(tasks, asOfDate = new Date().toISOString().slice(0, 10)) {
  const byEmp = new Map();
  for (const t of tasks) {
    const id = t.assigned_to_employee_id || 'unassigned';
    const name = t.assigned_to_name || (id === 'unassigned' ? 'Unassigned' : id);
    if (!byEmp.has(id)) {
      byEmp.set(id, {
        employeeId: id === 'unassigned' ? null : id,
        employeeName: name,
        total: 0,
        pending: 0,
        inProgress: 0,
        completed: 0,
        overdue: 0,
      });
    }
    const item = byEmp.get(id);
    item.total += 1;
    if (t.status === 'pending') item.pending += 1;
    else if (t.status === 'in_progress') item.inProgress += 1;
    else if (t.status === 'completed') item.completed += 1;

    if (isOverdue(t, asOfDate)) {
      item.overdue += 1;
    }
  }
  return Array.from(byEmp.values());
}
