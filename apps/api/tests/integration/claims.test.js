import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addUser, bearer, createTenant, login, setupTestApp, sys } from './helpers.js';

const { app, db, sms } = setupTestApp();

let t;
let other;
let hr;
let worker;
let workerToken;
let otherWorkerToken;

const api = (token) => ({
  get: (url) => request(app).get(`/api/v1${url}`).set(bearer(token)),
  post: (url, body = {}) => request(app).post(`/api/v1${url}`).set(bearer(token)).send(body),
});

async function employeeToken(company, mobile) {
  await sys(db, (x) =>
    x('otp_challenges').update({ created_at: x.raw("created_at - interval '1 minute'") }),
  );
  await request(app).post('/api/v1/auth/employee/request-otp').send({ company, mobile });
  const res = await request(app)
    .post('/api/v1/auth/employee/verify-otp')
    .send({ company, mobile, code: sms.lastCodeFor(`+91${mobile}`) });
  return res.body.accessToken;
}

beforeAll(async () => {
  t = await createTenant(db, 'clm');
  other = await createTenant(db, 'clmb');

  const hrUser = await addUser(db, t.organization.id, ['hr_manager'], 'hr');
  hr = api((await login(app, hrUser.email)).token);

  const workerRes = await hr.post('/hr/employees', {
    fullName: 'Clara Claimant',
    mobile: '9400000001',
    branchId: t.branch.id,
    joiningDate: '2026-01-01',
  });
  worker = workerRes.body;
  workerToken = await employeeToken(t.organization.slug, '9400000001');

  // Other tenant worker
  const otherHrUser = await addUser(db, other.organization.id, ['hr_manager'], 'otherhr');
  const otherHr = api((await login(app, otherHrUser.email)).token);
  await otherHr.post('/hr/employees', {
    fullName: 'Oscar Other',
    mobile: '9400000002',
    branchId: other.branch.id,
    joiningDate: '2026-01-01',
  });
  otherWorkerToken = await employeeToken(other.organization.slug, '9400000002');
});

afterAll(async () => {
  await db.destroy();
});

describe('Employee Financial Claims & Loans Integration Tests (§9)', () => {
  let loanClaimId;
  let advanceClaimId;

  it('Employee can submit an Employee Loan request (§9.1, §9.2)', async () => {
    const workerApi = api(workerToken);
    const res = await workerApi.post('/me/claims', {
      claimType: 'loan',
      requestedAmount: '5000000', // 50,000 INR in paise
      purpose: 'Medical emergency expenses',
      durationMonths: 12,
      repaymentNotes: 'Deduct from monthly salary over 12 months',
      idempotencyKey: 'loan-req-001',
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.claimType).toBe('loan');
    expect(res.body.requestedAmount).toBe('5000000');
    expect(res.body.status).toBe('pending');
    loanClaimId = res.body.id;
  });

  it('Submitting the same idempotency key returns the existing claim (idempotent)', async () => {
    const workerApi = api(workerToken);
    const res = await workerApi.post('/me/claims', {
      claimType: 'loan',
      requestedAmount: '5000000',
      purpose: 'Medical emergency expenses',
      durationMonths: 12,
      idempotencyKey: 'loan-req-001',
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(loanClaimId);
  });

  it('Employee can submit a Salary Advance request', async () => {
    expect(worker.id).toBeDefined();
    const workerApi = api(workerToken);
    const res = await workerApi.post('/me/claims', {
      claimType: 'salary_advance',
      requestedAmount: '1500000', // 15,000 INR
      purpose: 'Festival advance',
      durationMonths: 3,
    });

    expect(res.status).toBe(201);
    expect(res.body.claimType).toBe('salary_advance');
    expect(res.body.status).toBe('pending');
    advanceClaimId = res.body.id;
    expect(advanceClaimId).toBeDefined();
  });

  it('Employee can view their own claims history (/me/claims)', async () => {
    const workerApi = api(workerToken);
    const res = await workerApi.get('/me/claims');

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    expect(res.body.data.some((c) => c.id === loanClaimId)).toBe(true);
  });

  it('HR can view, approve, and adjust approved amount for loan request (§9.3)', async () => {
    const res = await hr.post(`/hr/claims/${loanClaimId}/decide`, {
      status: 'approved',
      approvedAmount: '4000000', // approved 40,000 INR
      decisionComment: 'Approved by HR with 40k cap',
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.approvedAmount).toBe('4000000');
    expect(res.body.decidedBy).not.toBeNull();
    expect(res.body.decisionComment).toBe('Approved by HR with 40k cap');
  });

  it('HR can record repayments and system tracks outstanding balance', async () => {
    // Record partial repayment of 10,000 INR (1,000,000 paise)
    const partialRes = await hr.post(`/hr/claims/${loanClaimId}/repay`, {
      amount: '1000000',
    });

    expect(partialRes.status).toBe(200);
    expect(partialRes.body.repaidAmount).toBe('1000000');
    expect(partialRes.body.outstandingAmount).toBe('3000000'); // 40,000 - 10,000
    expect(partialRes.body.repaymentComplete).toBe(false);

    // Record remaining repayment of 30,000 INR (3,000,000 paise)
    const fullRes = await hr.post(`/hr/claims/${loanClaimId}/repay`, {
      amount: '3000000',
    });

    expect(fullRes.status).toBe(200);
    expect(fullRes.body.repaidAmount).toBe('4000000');
    expect(fullRes.body.outstandingAmount).toBe('0');
    expect(fullRes.body.repaymentComplete).toBe(true);
  });

  it('HR / Owner financial analytics dashboard computes aggregates (§9.4, §11.5)', async () => {
    const res = await hr.get('/hr/claims/analytics');

    expect(res.status).toBe(200);
    expect(res.body.totals.totalCount).toBeGreaterThanOrEqual(2);
    expect(res.body.totals.approvedCount).toBeGreaterThanOrEqual(1);
    expect(res.body.byType.loan).toBeDefined();
    expect(res.body.byHr.length).toBeGreaterThanOrEqual(1);
  });

  it('Prevents cross-tenant access to financial claims', async () => {
    const otherWorkerApi = api(otherWorkerToken);

    // Tenant B cannot view Tenant A claim
    const getRes = await otherWorkerApi.get(`/hr/claims/${loanClaimId}`);
    expect(getRes.status).toBe(403); // or 404
  });
});
