import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../core/validate.js';
import { isUuid, withTenant } from '../../core/db.js';
import { notFound, forbidden } from '../../core/errors.js';
import { PERMISSIONS, requirePermission } from '../staff-access/permissions.js';
import {
  baseClaimQuery,
  decideClaim,
  getClaimById,
  presentClaim,
  recordRepayment,
  submitClaim,
} from './service.js';
import { calculateClaimStats } from './calc.js';

const P = PERMISSIONS;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const CLAIM_TYPES = ['insurance', 'salary_advance', 'loan', 'other'];
const CLAIM_STATUSES = ['pending', 'approved', 'rejected'];

// Money in paise (string of digits or integer)
const amountSchema = z
  .union([z.string().regex(/^\d+$/, 'Must be an integer amount in paise'), z.number().int().min(0)])
  .transform((v) => String(v));

const submitClaimSchema = z
  .object({
    claimType: z.enum(CLAIM_TYPES),
    claimTypeLabel: z.string().trim().max(100).optional(),
    requestedAmount: amountSchema.optional(),
    purpose: z.string().trim().min(3).max(1000),
    requestedDate: DATE.optional(),
    durationMonths: z.number().int().min(1).max(60).optional(),
    repaymentNotes: z.string().trim().max(1000).optional(),
    supportingDocumentUrl: z.string().trim().url().max(1000).optional(),
    additionalComments: z.string().trim().max(2000).optional(),
    idempotencyKey: z.string().trim().max(100).optional(),
  })
  .strict();

const decideClaimSchema = z
  .object({
    status: z.enum(['approved', 'rejected']),
    decisionComment: z.string().trim().max(1000).optional(),
    approvedAmount: amountSchema.optional(),
  })
  .strict();

const repayClaimSchema = z
  .object({
    amount: amountSchema,
  })
  .strict();

const listQuerySchema = z.object({
  status: z.enum([...CLAIM_STATUSES, 'all']).default('all'),
  claimType: z.enum([...CLAIM_TYPES, 'all']).default('all'),
  employeeId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function claimsRouter({ db }) {
  const router = Router();

  // HR / Owner list all claims
  router.get('/', requirePermission(P.CLAIMS_READ), async (req, res) => {
    const q = validate(listQuerySchema, req.query);
    const orgId = req.auth.organizationId;

    const result = await withTenant(db, orgId, async (trx) => {
      let query = baseClaimQuery(trx, orgId);

      if (req.auth.branchIds !== null) {
        query = query.whereIn('e.branch_id', req.auth.branchIds);
      }
      if (q.status !== 'all') {
        query = query.where('c.status', q.status);
      }
      if (q.claimType !== 'all') {
        query = query.where('c.claim_type', q.claimType);
      }
      if (q.employeeId) {
        query = query.where('c.employee_id', q.employeeId);
      }
      if (q.departmentId) {
        query = query.where('e.department_id', q.departmentId);
      }
      if (q.branchId) {
        query = query.where('e.branch_id', q.branchId);
      }

      const countResult = await query.clone().clearSelect().count({ total: '*' }).first();
      const total = Number(countResult?.total ?? 0);

      const rows = await query.orderBy('c.created_at', 'desc').limit(q.limit).offset(q.offset);

      return {
        total,
        data: rows.map(presentClaim),
      };
    });

    res.json(result);
  });

  // Owner Financial Dashboard & Analytics (§9.4, §11.5)
  router.get('/analytics', requirePermission(P.CLAIMS_READ), async (req, res) => {
    const orgId = req.auth.organizationId;

    const stats = await withTenant(db, orgId, async (trx) => {
      let query = baseClaimQuery(trx, orgId);
      if (req.auth.branchIds !== null) {
        query = query.whereIn('e.branch_id', req.auth.branchIds);
      }
      const claims = await query;
      return calculateClaimStats(claims);
    });

    res.json(stats);
  });

  // HR view single claim
  router.get('/:id', requirePermission(P.CLAIMS_READ), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const orgId = req.auth.organizationId;

    const claim = await withTenant(db, orgId, async (trx) => {
      const c = await getClaimById(trx, orgId, req.params.id);
      if (req.auth.branchIds !== null && !req.auth.branchIds.includes(c.branch_id)) {
        throw forbidden();
      }
      return c;
    });

    res.json(presentClaim(claim));
  });

  // HR approve / reject claim
  router.post('/:id/decide', requirePermission(P.CLAIMS_MANAGE), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body = validate(decideClaimSchema, req.body);
    const orgId = req.auth.organizationId;

    const claim = await withTenant(db, orgId, async (trx) => {
      const c = await getClaimById(trx, orgId, req.params.id);
      if (req.auth.branchIds !== null && !req.auth.branchIds.includes(c.branch_id)) {
        throw forbidden();
      }
      return decideClaim(trx, orgId, req.params.id, body, req.auth.userId);
    });

    res.json(presentClaim(claim));
  });

  // HR record loan/advance repayment
  router.post('/:id/repay', requirePermission(P.CLAIMS_MANAGE), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound();
    const body = validate(repayClaimSchema, req.body);
    const orgId = req.auth.organizationId;

    const claim = await withTenant(db, orgId, async (trx) => {
      const c = await getClaimById(trx, orgId, req.params.id);
      if (req.auth.branchIds !== null && !req.auth.branchIds.includes(c.branch_id)) {
        throw forbidden();
      }
      return recordRepayment(trx, orgId, req.params.id, body.amount, req.auth.userId);
    });

    res.json(presentClaim(claim));
  });

  return router;
}

/**
 * Self-service financial requests for normal employees (§9.1, §9.2).
 */
export function selfClaimsRouter({ db }) {
  const router = Router();

  const requireEmployee = (req) => {
    if (!req.auth.employee) throw notFound('No employee profile linked to this login');
    return req.auth.employee.id;
  };

  // Employee list own claims
  router.get('/', async (req, res) => {
    const me = requireEmployee(req);
    const orgId = req.auth.organizationId;

    const rows = await withTenant(db, orgId, (trx) =>
      baseClaimQuery(trx, orgId).where('c.employee_id', me).orderBy('c.created_at', 'desc'),
    );

    res.json({ data: rows.map(presentClaim) });
  });

  // Employee submit financial request
  router.post('/', async (req, res) => {
    const me = requireEmployee(req);
    const body = validate(submitClaimSchema, req.body);
    const orgId = req.auth.organizationId;

    const claim = await withTenant(db, orgId, (trx) => submitClaim(trx, orgId, me, body));

    res.status(201).json(presentClaim(claim));
  });

  // Employee view specific claim
  router.get('/:id', async (req, res) => {
    const me = requireEmployee(req);
    if (!isUuid(req.params.id)) throw notFound();
    const orgId = req.auth.organizationId;

    const claim = await withTenant(db, orgId, async (trx) => {
      const c = await getClaimById(trx, orgId, req.params.id);
      if (c.employee_id !== me) throw forbidden('You can only view your own claims');
      return c;
    });

    res.json(presentClaim(claim));
  });

  return router;
}
