import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  mgtError,
  notFound,
  opsError,
  platformError,
  unauthorized,
} from '../src/core/errors.js';
import {
  errorHandler,
  notFoundHandler,
  requestId,
  resolveProductDomain,
} from '../src/core/middleware.js';

describe('Phase 5: Standardized Error Handling & Cross-Service Observability', () => {
  describe('AppError & Domain-Specific Factories', () => {
    it('constructs standard AppError with backward-compatible defaults', () => {
      const err = new AppError(404, 'NOT_FOUND', 'Item not found');
      expect(err.name).toBe('AppError');
      expect(err.status).toBe(404);
      expect(err.code).toBe('NOT_FOUND');
      expect(err.message).toBe('Item not found');
      expect(err.product).toBeNull();
      expect(err.details).toBeUndefined();
    });

    it('constructs AppError with plain details object', () => {
      const details = { field: 'email', reason: 'invalid format' };
      const err = new AppError(400, 'VALIDATION_ERROR', 'Validation failed', details);
      expect(err.details).toEqual(details);
      expect(err.product).toBeNull();
    });

    it('constructs AppError with product option', () => {
      const err = new AppError(409, 'SLOT_FULL', 'Slot taken', {
        product: 'suntek-ops',
        details: { slot: '10:00' },
      });
      expect(err.product).toBe('suntek-ops');
      expect(err.details).toEqual({ slot: '10:00' });
    });

    it('mgtError factory tags error with suntek-mgt', () => {
      const err = mgtError(400, 'INSUFFICIENT_LEAVE_BALANCE', 'Only 1 day left', { balance: 1 });
      expect(err.status).toBe(400);
      expect(err.code).toBe('INSUFFICIENT_LEAVE_BALANCE');
      expect(err.product).toBe('suntek-mgt');
      expect(err.details).toEqual({ balance: 1 });
    });

    it('opsError factory tags error with suntek-ops', () => {
      const err = opsError(409, 'DOCTOR_INACTIVE', 'Doctor not active');
      expect(err.status).toBe(409);
      expect(err.code).toBe('DOCTOR_INACTIVE');
      expect(err.product).toBe('suntek-ops');
    });

    it('platformError factory tags error with platform', () => {
      const err = platformError(403, 'PLATFORM_FORBIDDEN', 'Requires platform admin');
      expect(err.status).toBe(403);
      expect(err.code).toBe('PLATFORM_FORBIDDEN');
      expect(err.product).toBe('platform');
    });

    it('helper factories support optional product options', () => {
      expect(notFound('Doctor not found', { product: 'suntek-ops' }).product).toBe('suntek-ops');
      expect(forbidden('No access', { product: 'suntek-mgt' }).product).toBe('suntek-mgt');
      expect(unauthorized('Login needed', { product: 'shared' }).product).toBe('shared');
      expect(conflict('ALREADY_BOOKED', 'Overlap', { product: 'suntek-ops' }).product).toBe(
        'suntek-ops',
      );
      expect(badRequest('INVALID_INPUT', 'Bad data', { product: 'suntek-mgt' }).product).toBe(
        'suntek-mgt',
      );
    });
  });

  describe('Correlation ID & Request ID Middleware', () => {
    it('generates unique request and correlation IDs when incoming headers are absent', () => {
      const req = { get: () => undefined };
      const res = { set: vi.fn() };
      const next = vi.fn();

      requestId(req, res, next);
      expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(req.correlationId).toBe(req.id);
      expect(res.set).toHaveBeenCalledWith('x-request-id', req.id);
      expect(res.set).toHaveBeenCalledWith('x-correlation-id', req.correlationId);
      expect(next).toHaveBeenCalled();
    });

    it('accepts and propagates valid incoming X-Correlation-ID', () => {
      const incomingCorrelation = 'trace-corr-12345';
      const req = {
        get: (header) => (header === 'x-correlation-id' ? incomingCorrelation : undefined),
      };
      const res = { set: vi.fn() };
      const next = vi.fn();

      requestId(req, res, next);
      expect(req.correlationId).toBe(incomingCorrelation);
      expect(res.set).toHaveBeenCalledWith('x-correlation-id', incomingCorrelation);
    });

    it('replaces malformed / dangerous incoming IDs with safe UUID', () => {
      const req = {
        get: () => 'malicious<script>alert(1)</script>',
      };
      const res = { set: vi.fn() };
      const next = vi.fn();

      requestId(req, res, next);
      expect(req.id).not.toContain('<script>');
      expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('Product Domain Resolution', () => {
    it('resolves product from request path', () => {
      expect(resolveProductDomain({ originalUrl: '/api/v1/mgt/employees' })).toBe('suntek-mgt');
      expect(resolveProductDomain({ originalUrl: '/api/v1/ops/appointments' })).toBe('suntek-ops');
      expect(resolveProductDomain({ originalUrl: '/api/v1/platform/organizations' })).toBe(
        'platform',
      );
      expect(resolveProductDomain({ originalUrl: '/api/v1/health' })).toBe('shared');
    });

    it('prioritizes explicit product on error over request path', () => {
      const err = { product: 'suntek-mgt' };
      expect(resolveProductDomain({ originalUrl: '/api/v1/ops/doctors' }, err)).toBe('suntek-mgt');
    });
  });

  describe('Centralized Error Handler Middleware', () => {
    const buildTestApp = () => {
      const app = express();
      app.use(requestId);
      app.get('/api/v1/mgt/test-error', () => {
        throw mgtError(422, 'PAYROLL_LOCKED', 'Period is finalized');
      });
      app.get('/api/v1/ops/test-error', () => {
        throw opsError(409, 'DOCTOR_UNAVAILABLE', 'Doctor is on leave', { date: '2026-11-25' });
      });
      app.get('/api/v1/shared/crash', () => {
        throw new Error('Database connection dropped unexpectedly');
      });
      app.use(notFoundHandler);
      app.use(errorHandler);
      return app;
    };

    it('renders Mgt error with product classification and correlation ID', async () => {
      const app = buildTestApp();
      const res = await request(app)
        .get('/api/v1/mgt/test-error')
        .set('X-Correlation-ID', 'trace-mgt-999');

      expect(res.status).toBe(422);
      expect(res.headers['x-correlation-id']).toBe('trace-mgt-999');
      expect(res.body).toEqual({
        error: {
          code: 'PAYROLL_LOCKED',
          message: 'Period is finalized',
          product: 'suntek-mgt',
          correlationId: 'trace-mgt-999',
          requestId: expect.any(String),
        },
      });
    });

    it('renders Ops error with product classification, details, and correlation ID', async () => {
      const app = buildTestApp();
      const res = await request(app).get('/api/v1/ops/test-error');

      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'DOCTOR_UNAVAILABLE',
        message: 'Doctor is on leave',
        product: 'suntek-ops',
        details: { date: '2026-11-25' },
        correlationId: expect.any(String),
        requestId: expect.any(String),
      });
    });

    it('masks unexpected internal 500 error messages for client security', async () => {
      const app = buildTestApp();
      const res = await request(app).get('/api/v1/shared/crash');

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(res.body.error.message).toBe('An unexpected error occurred');
      expect(res.body.error.message).not.toContain('Database');
      expect(res.body.error.product).toBe('shared');
      expect(res.body.error.correlationId).toBeDefined();
    });

    it('resolves product on 404 route not found based on route prefix', async () => {
      const app = buildTestApp();
      const res = await request(app).get('/api/v1/mgt/unknown-endpoint');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
      expect(res.body.error.product).toBe('suntek-mgt');
    });
  });
});
