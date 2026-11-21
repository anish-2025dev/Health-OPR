import { notFound, AppError, conflict } from '../../core/errors.js';
import { recordAudit } from '../audit/index.js';

export function presentClaim(c) {
  const approved = c.approved_amount ? BigInt(c.approved_amount) : 0n;
  const repaid = c.repaid_amount ? BigInt(c.repaid_amount) : 0n;
  const outstanding = approved > repaid ? approved - repaid : 0n;

  return {
    id: c.id,
    claimType: c.claim_type,
    claimTypeLabel: c.claim_type_label,
    requestedAmount: c.requested_amount ? String(c.requested_amount) : null,
    purpose: c.purpose,
    requestedDate: c.requested_date,
    durationMonths: c.duration_months,
    repaymentNotes: c.repayment_notes,
    supportingDocumentUrl: c.supporting_document_url,
    additionalComments: c.additional_comments,
    status: c.status,
    approvedAmount: c.approved_amount ? String(c.approved_amount) : null,
    repaidAmount: String(c.repaid_amount || '0'),
    outstandingAmount: String(outstanding),
    repaymentComplete: Boolean(c.repayment_complete),
    employee: c.employee_id
      ? {
          id: c.employee_id,
          fullName: c.employee_name,
          employeeNumber: c.employee_number,
          department: c.department_name,
          branchId: c.branch_id,
        }
      : null,
    decidedBy: c.decided_by_user_id
      ? {
          id: c.decided_by_user_id,
          fullName: c.decider_name,
        }
      : null,
    decidedAt: c.decided_at,
    decisionComment: c.decision_comment,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

export function baseClaimQuery(trx, orgId) {
  return trx('employee_claims as c')
    .join('employees as e', 'e.id', 'c.employee_id')
    .leftJoin('departments as d', 'd.id', 'e.department_id')
    .leftJoin('users as u', 'u.id', 'c.decided_by_user_id')
    .where('c.organization_id', orgId)
    .select(
      'c.*',
      'e.full_name as employee_name',
      'e.employee_number',
      'e.branch_id',
      'd.name as department_name',
      'u.full_name as decider_name',
    );
}

export async function getClaimById(trx, orgId, claimId) {
  const row = await baseClaimQuery(trx, orgId).where('c.id', claimId).first();
  if (!row) throw notFound('Claim request not found');
  return row;
}

export async function submitClaim(trx, orgId, employeeId, data) {
  // Check employee belongs to org and is active/on_notice
  const emp = await trx('employees')
    .where({ organization_id: orgId, id: employeeId })
    .whereIn('employment_status', ['active', 'on_notice'])
    .first('id', 'branch_id');
  if (!emp) throw notFound('Active employee not found');

  if (data.idempotencyKey) {
    const existing = await trx('employee_claims')
      .where({ organization_id: orgId, idempotency_key: data.idempotencyKey })
      .first('id');
    if (existing) {
      return getClaimById(trx, orgId, existing.id);
    }
  }

  const [row] = await trx('employee_claims')
    .insert({
      organization_id: orgId,
      employee_id: employeeId,
      claim_type: data.claimType,
      claim_type_label: data.claimTypeLabel || null,
      requested_amount: data.requestedAmount || null,
      purpose: data.purpose,
      requested_date: data.requestedDate || trx.raw('CURRENT_DATE'),
      duration_months: data.durationMonths || null,
      repayment_notes: data.repaymentNotes || null,
      supporting_document_url: data.supportingDocumentUrl || null,
      additional_comments: data.additionalComments || null,
      idempotency_key: data.idempotencyKey || null,
      status: 'pending',
    })
    .returning('*');

  await recordAudit(trx, {
    organizationId: orgId,
    actorUserId: null,
    action: 'claim.submitted',
    entityType: 'employee_claim',
    entityId: row.id,
    metadata: {
      claimType: row.claim_type,
      requestedAmount: row.requested_amount,
      employeeId,
    },
  });

  return getClaimById(trx, orgId, row.id);
}

export async function decideClaim(trx, orgId, claimId, decision, actorUserId) {
  const claim = await getClaimById(trx, orgId, claimId);
  if (claim.status !== 'pending') {
    throw conflict('CLAIM_ALREADY_DECIDED', 'This claim has already been decided');
  }

  const patch = {
    status: decision.status,
    decision_comment: decision.decisionComment || null,
    decided_by_user_id: actorUserId,
    decided_at: trx.fn.now(),
    updated_at: trx.fn.now(),
  };

  if (decision.status === 'approved') {
    patch.approved_amount = decision.approvedAmount || claim.requested_amount || 0;
  }

  await trx('employee_claims').where({ organization_id: orgId, id: claimId }).update(patch);

  await recordAudit(trx, {
    organizationId: orgId,
    actorUserId,
    action: `claim.${decision.status}`,
    entityType: 'employee_claim',
    entityId: claimId,
    metadata: {
      status: decision.status,
      approvedAmount: patch.approved_amount,
      claimType: claim.claim_type,
      employeeId: claim.employee_id,
    },
  });

  return getClaimById(trx, orgId, claimId);
}

export async function recordRepayment(trx, orgId, claimId, amountPaise, actorUserId) {
  const claim = await getClaimById(trx, orgId, claimId);
  if (claim.status !== 'approved') {
    throw new AppError(400, 'CLAIM_NOT_APPROVED', 'Can only record repayment for approved claims');
  }

  const approved = BigInt(claim.approved_amount || 0);
  const currentRepaid = BigInt(claim.repaid_amount || 0);
  const additional = BigInt(amountPaise);
  if (additional <= 0n) {
    throw new AppError(400, 'INVALID_AMOUNT', 'Repayment amount must be positive');
  }

  const newRepaid = currentRepaid + additional;
  const isComplete = newRepaid >= approved;

  await trx('employee_claims').where({ organization_id: orgId, id: claimId }).update({
    repaid_amount: newRepaid.toString(),
    repayment_complete: isComplete,
    updated_at: trx.fn.now(),
  });

  await recordAudit(trx, {
    organizationId: orgId,
    actorUserId,
    action: 'claim.repayment_recorded',
    entityType: 'employee_claim',
    entityId: claimId,
    metadata: {
      additionalRepayment: additional.toString(),
      totalRepaid: newRepaid.toString(),
      repaymentComplete: isComplete,
    },
  });

  return getClaimById(trx, orgId, claimId);
}
