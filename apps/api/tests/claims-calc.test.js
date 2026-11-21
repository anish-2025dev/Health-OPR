import { describe, expect, it } from 'vitest';
import { calculateClaimStats } from '../src/modules/hr-claims/calc.js';

describe('Financial Claims calculations (calc.js)', () => {
  it('correctly calculates claim totals, amounts in paise, and outstanding loans', () => {
    const claims = [
      {
        id: '1',
        claim_type: 'loan',
        requested_amount: '5000000', // 50,000 INR
        approved_amount: '4000000', // 40,000 INR
        repaid_amount: '1000000', // 10,000 INR
        status: 'approved',
        decided_by_user_id: 'hr-1',
        decider_name: 'HR Officer',
        department_name: 'Cardiology',
      },
      {
        id: '2',
        claim_type: 'salary_advance',
        requested_amount: '1500000', // 15,000 INR
        approved_amount: '1500000',
        repaid_amount: '1500000',
        status: 'approved',
        decided_by_user_id: 'hr-1',
        decider_name: 'HR Officer',
        department_name: 'Radiology',
      },
      {
        id: '3',
        claim_type: 'insurance',
        requested_amount: '2000000',
        approved_amount: null,
        repaid_amount: '0',
        status: 'pending',
        decided_by_user_id: null,
        department_name: 'Cardiology',
      },
      {
        id: '4',
        claim_type: 'loan',
        requested_amount: '10000000',
        approved_amount: null,
        repaid_amount: '0',
        status: 'rejected',
        decided_by_user_id: 'hr-2',
        decider_name: 'HR Lead',
        department_name: 'Surgery',
      },
    ];

    const stats = calculateClaimStats(claims);

    expect(stats.totals.totalCount).toBe(4);
    expect(stats.totals.pendingCount).toBe(1);
    expect(stats.totals.approvedCount).toBe(2);
    expect(stats.totals.rejectedCount).toBe(1);

    // Amounts in paise (strings)
    expect(stats.totals.totalRequestedAmount).toBe('18500000');
    expect(stats.totals.totalApprovedAmount).toBe('5500000');
    expect(stats.totals.totalRepaidAmount).toBe('2500000');
    expect(stats.totals.totalOutstandingAmount).toBe('3000000'); // 40,000 - 10,000 = 30,000 INR (3,000,000 paise)

    // Breakdown by type
    expect(stats.byType.loan).toEqual({
      count: 2,
      approvedAmount: '4000000',
      outstandingAmount: '3000000',
    });
    expect(stats.byType.salary_advance).toEqual({
      count: 1,
      approvedAmount: '1500000',
      outstandingAmount: '0',
    });
    expect(stats.byType.insurance).toEqual({
      count: 1,
      approvedAmount: '0',
      outstandingAmount: '0',
    });

    // Breakdown by HR
    expect(stats.byHr).toHaveLength(2);
    const hr1 = stats.byHr.find((h) => h.hrUserId === 'hr-1');
    expect(hr1.totalDecided).toBe(2);
    expect(hr1.approved).toBe(2);
    expect(hr1.totalApprovedAmount).toBe('5500000');

    const hr2 = stats.byHr.find((h) => h.hrUserId === 'hr-2');
    expect(hr2.totalDecided).toBe(1);
    expect(hr2.rejected).toBe(1);
    expect(hr2.totalApprovedAmount).toBe('0');

    // Breakdown by department
    expect(stats.byDepartment).toHaveLength(3);
    const cardio = stats.byDepartment.find((d) => d.department === 'Cardiology');
    expect(cardio.totalRequests).toBe(2);
    expect(cardio.approvedRequests).toBe(1);
    expect(cardio.totalApprovedAmount).toBe('4000000');
    expect(cardio.totalOutstandingAmount).toBe('3000000');
  });
});
