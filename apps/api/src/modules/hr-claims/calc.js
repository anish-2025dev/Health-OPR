/**
 * Pure calculation functions for Employee Financial Claims & Loans (§9).
 * Handles money in paise (BigInt or string).
 */

export function calculateClaimStats(claims) {
  let totalRequestedAmount = 0n;
  let totalApprovedAmount = 0n;
  let totalRepaidAmount = 0n;
  let totalOutstandingAmount = 0n;

  let totalCount = claims.length;
  let pendingCount = 0;
  let approvedCount = 0;
  let rejectedCount = 0;

  const byType = {
    insurance: { count: 0, approvedAmount: 0n },
    salary_advance: { count: 0, approvedAmount: 0n, outstandingAmount: 0n },
    loan: { count: 0, approvedAmount: 0n, outstandingAmount: 0n },
    other: { count: 0, approvedAmount: 0n },
  };

  const byHr = new Map();
  const byDepartment = new Map();

  for (const c of claims) {
    const requested = BigInt(c.requested_amount || 0);
    const approved = BigInt(c.approved_amount || 0);
    const repaid = BigInt(c.repaid_amount || 0);
    const outstanding = approved > repaid ? approved - repaid : 0n;

    totalRequestedAmount += requested;

    if (c.status === 'pending') {
      pendingCount += 1;
    } else if (c.status === 'approved') {
      approvedCount += 1;
      totalApprovedAmount += approved;
      totalRepaidAmount += repaid;
      totalOutstandingAmount += outstanding;
    } else if (c.status === 'rejected') {
      rejectedCount += 1;
    }

    if (byType[c.claim_type]) {
      byType[c.claim_type].count += 1;
      if (c.status === 'approved') {
        byType[c.claim_type].approvedAmount += approved;
        if (byType[c.claim_type].outstandingAmount !== undefined) {
          byType[c.claim_type].outstandingAmount += outstanding;
        }
      }
    }

    // HR Decider Stats
    if (c.decided_by_user_id) {
      const deciderId = c.decided_by_user_id;
      const deciderName = c.decider_name || deciderId;
      if (!byHr.has(deciderId)) {
        byHr.set(deciderId, {
          hrUserId: deciderId,
          hrName: deciderName,
          totalDecided: 0,
          approved: 0,
          rejected: 0,
          totalApprovedAmount: 0n,
        });
      }
      const hrStat = byHr.get(deciderId);
      hrStat.totalDecided += 1;
      if (c.status === 'approved') {
        hrStat.approved += 1;
        hrStat.totalApprovedAmount += approved;
      } else if (c.status === 'rejected') {
        hrStat.rejected += 1;
      }
    }

    // Department Stats
    const deptName = c.department_name || 'No department';
    if (!byDepartment.has(deptName)) {
      byDepartment.set(deptName, {
        department: deptName,
        totalRequests: 0,
        approvedRequests: 0,
        totalApprovedAmount: 0n,
        totalOutstandingAmount: 0n,
      });
    }
    const deptStat = byDepartment.get(deptName);
    deptStat.totalRequests += 1;
    if (c.status === 'approved') {
      deptStat.approvedRequests += 1;
      deptStat.totalApprovedAmount += approved;
      deptStat.totalOutstandingAmount += outstanding;
    }
  }

  return {
    totals: {
      totalCount,
      pendingCount,
      approvedCount,
      rejectedCount,
      totalRequestedAmount: totalRequestedAmount.toString(),
      totalApprovedAmount: totalApprovedAmount.toString(),
      totalRepaidAmount: totalRepaidAmount.toString(),
      totalOutstandingAmount: totalOutstandingAmount.toString(),
    },
    byType: Object.fromEntries(
      Object.entries(byType).map(([k, v]) => [
        k,
        {
          count: v.count,
          approvedAmount: v.approvedAmount.toString(),
          outstandingAmount:
            v.outstandingAmount !== undefined ? v.outstandingAmount.toString() : '0',
        },
      ]),
    ),
    byHr: Array.from(byHr.values()).map((h) => ({
      ...h,
      totalApprovedAmount: h.totalApprovedAmount.toString(),
    })),
    byDepartment: Array.from(byDepartment.values()).map((d) => ({
      ...d,
      totalApprovedAmount: d.totalApprovedAmount.toString(),
      totalOutstandingAmount: d.totalOutstandingAmount.toString(),
    })),
  };
}
