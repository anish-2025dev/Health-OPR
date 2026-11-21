import { describe, expect, it } from 'vitest';
import { isOverdue, summarizeTasks, summarizeWorkloads } from '../src/modules/tasks/calc.js';

describe('Task calculations (calc.js)', () => {
  const asOf = '2026-11-20';

  it('correctly identifies overdue tasks', () => {
    expect(isOverdue({ deadline: '2026-11-19', status: 'pending' }, asOf)).toBe(true);
    expect(isOverdue({ deadline: '2026-11-19', status: 'in_progress' }, asOf)).toBe(true);
    expect(isOverdue({ deadline: '2026-11-19', status: 'completed' }, asOf)).toBe(false);
    expect(isOverdue({ deadline: '2026-11-19', status: 'cancelled' }, asOf)).toBe(false);
    expect(isOverdue({ deadline: '2026-11-20', status: 'pending' }, asOf)).toBe(false);
    expect(isOverdue({ deadline: '2026-11-21', status: 'pending' }, asOf)).toBe(false);
    expect(isOverdue({ deadline: null, status: 'pending' }, asOf)).toBe(false);
  });

  it('summarizes task statuses and priorities', () => {
    const tasks = [
      { id: '1', status: 'pending', priority: 'high', deadline: '2026-11-18' }, // overdue
      { id: '2', status: 'in_progress', priority: 'critical', deadline: '2026-11-25' },
      { id: '3', status: 'on_hold', priority: 'medium', deadline: null },
      { id: '4', status: 'completed', priority: 'low', deadline: '2026-11-10' }, // not overdue since completed
      { id: '5', status: 'cancelled', priority: 'medium', deadline: '2026-11-15' },
    ];

    const summary = summarizeTasks(tasks, asOf);

    expect(summary.total).toBe(5);
    expect(summary.pending).toBe(1);
    expect(summary.inProgress).toBe(1);
    expect(summary.onHold).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.cancelled).toBe(1);
    expect(summary.overdue).toBe(1);
    expect(summary.byPriority).toEqual({
      low: 1,
      medium: 2,
      high: 1,
      critical: 1,
    });
  });

  it('summarizes workload by employee', () => {
    const tasks = [
      {
        id: '1',
        assigned_to_employee_id: 'emp-1',
        assigned_to_name: 'Alice',
        status: 'pending',
        deadline: '2026-11-15',
      },
      {
        id: '2',
        assigned_to_employee_id: 'emp-1',
        assigned_to_name: 'Alice',
        status: 'in_progress',
        deadline: '2026-11-22',
      },
      {
        id: '3',
        assigned_to_employee_id: 'emp-2',
        assigned_to_name: 'Bob',
        status: 'completed',
        deadline: '2026-11-10',
      },
      {
        id: '4',
        assigned_to_employee_id: null,
        status: 'pending',
        deadline: '2026-11-25',
      },
    ];

    const workloads = summarizeWorkloads(tasks, asOf);
    expect(workloads).toHaveLength(3);

    const alice = workloads.find((w) => w.employeeId === 'emp-1');
    expect(alice).toEqual({
      employeeId: 'emp-1',
      employeeName: 'Alice',
      total: 2,
      pending: 1,
      inProgress: 1,
      completed: 0,
      overdue: 1,
    });

    const bob = workloads.find((w) => w.employeeId === 'emp-2');
    expect(bob).toEqual({
      employeeId: 'emp-2',
      employeeName: 'Bob',
      total: 1,
      pending: 0,
      inProgress: 0,
      completed: 1,
      overdue: 0,
    });

    const unassigned = workloads.find((w) => w.employeeId === null);
    expect(unassigned.total).toBe(1);
    expect(unassigned.pending).toBe(1);
  });
});
