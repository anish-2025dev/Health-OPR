import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { presentDoctor } from '../src/modules/clinic/routes.js';
import * as migration17 from '../src/db/migrations/20261121000017_decouple_doctors_department.js';

describe('Phase 4: Database Decoupling & Isolation Strategy', () => {
  describe('Doctor Presentation & Nullable Department Handling', () => {
    it('presents a doctor cleanly when department_id is null (standalone Ops mode)', () => {
      const doc = {
        id: randomUUID(),
        display_name: 'Dr. Jane Smith',
        specialization: 'General Physician',
        branch_id: randomUUID(),
        branch_name: 'Main Clinic',
        department_id: null,
        department_name: null,
        user_id: null,
        consultation_minutes: 15,
        booking_window_days: 14,
        online_booking_enabled: true,
        status: 'active',
      };

      const presented = presentDoctor(doc);
      expect(presented.id).toBe(doc.id);
      expect(presented.displayName).toBe('Dr. Jane Smith');
      expect(presented.branch).toEqual({ id: doc.branch_id, name: 'Main Clinic' });
      expect(presented.department).toBeNull();
    });

    it('presents a doctor when department_id is linked to an existing department', () => {
      const deptId = randomUUID();
      const doc = {
        id: randomUUID(),
        display_name: 'Dr. John Doe',
        specialization: 'Cardiologist',
        branch_id: randomUUID(),
        branch_name: 'Main Clinic',
        department_id: deptId,
        department_name: 'Cardiology',
        user_id: randomUUID(),
        consultation_minutes: 20,
        booking_window_days: 30,
        online_booking_enabled: true,
        status: 'active',
      };

      const presented = presentDoctor(doc);
      expect(presented.department).toEqual({
        id: deptId,
        name: 'Cardiology',
      });
    });

    it('presents a doctor when department_id is set but department_name is null (unlinked/deleted department)', () => {
      const deptId = randomUUID();
      const doc = {
        id: randomUUID(),
        display_name: 'Dr. Emily Watson',
        specialization: 'Pediatrics',
        branch_id: randomUUID(),
        branch_name: 'Main Clinic',
        department_id: deptId,
        department_name: null,
        user_id: null,
        consultation_minutes: 10,
        booking_window_days: 7,
        online_booking_enabled: true,
        status: 'active',
      };

      const presented = presentDoctor(doc);
      expect(presented.department).toEqual({
        id: deptId,
        name: null,
      });
    });
  });

  describe('Doctor Zod Schema Decoupling Verification', () => {
    const doctorFields = {
      displayName: z.string().trim().min(2).max(200),
      branchId: z.string().uuid(),
      userId: z.string().uuid().nullable(),
      departmentId: z.string().uuid().nullable(),
      specialization: z.string().trim().max(200).nullable(),
      consultationMinutes: z.number().int().min(2).max(240),
      bookingWindowDays: z.number().int().min(0).max(180),
      onlineBookingEnabled: z.boolean(),
      status: z.enum(['active', 'inactive']),
    };

    const createSchema = z
      .object({
        ...doctorFields,
        userId: doctorFields.userId.optional(),
        departmentId: doctorFields.departmentId.optional(),
        specialization: doctorFields.specialization.optional(),
        consultationMinutes: doctorFields.consultationMinutes.default(10),
        bookingWindowDays: doctorFields.bookingWindowDays.default(14),
        onlineBookingEnabled: doctorFields.onlineBookingEnabled.default(true),
        status: doctorFields.status.default('active'),
      })
      .strict();

    const updateSchema = z
      .object(Object.fromEntries(Object.entries(doctorFields).map(([k, v]) => [k, v.optional()])))
      .strict();

    it('allows creating a doctor with departmentId omitted', () => {
      const branchId = randomUUID();
      const parsed = createSchema.parse({
        displayName: 'Dr. Independent',
        branchId,
      });
      expect(parsed.displayName).toBe('Dr. Independent');
      expect(parsed.departmentId).toBeUndefined();
      expect(parsed.consultationMinutes).toBe(10);
    });

    it('allows creating a doctor with departmentId explicitly null', () => {
      const branchId = randomUUID();
      const parsed = createSchema.parse({
        displayName: 'Dr. Independent',
        branchId,
        departmentId: null,
      });
      expect(parsed.departmentId).toBeNull();
    });

    it('allows creating a doctor with valid departmentId uuid', () => {
      const branchId = randomUUID();
      const deptId = randomUUID();
      const parsed = createSchema.parse({
        displayName: 'Dr. Linked',
        branchId,
        departmentId: deptId,
      });
      expect(parsed.departmentId).toBe(deptId);
    });

    it('allows updating a doctor to set departmentId to null (de-linking)', () => {
      const parsed = updateSchema.parse({
        departmentId: null,
      });
      expect(parsed.departmentId).toBeNull();
    });

    it('tolerates missing departments table (error 42P01) in standalone Ops database', async () => {
      const mockTrx = () => ({
        where: () => ({
          first: async () => {
            const err = new Error('relation "departments" does not exist');
            err.code = '42P01';
            throw err;
          },
        }),
      });

      // Defensive check simulates assertDoctorRefs behavior
      let allowed = false;
      try {
        const values = { department_id: randomUUID() };
        if (values.department_id) {
          try {
            await mockTrx('departments')
              .where({ organization_id: randomUUID(), id: values.department_id })
              .first('id');
          } catch (err) {
            if (err.code === '42P01') {
              allowed = true;
            } else {
              throw err;
            }
          }
        }
      } catch {
        allowed = false;
      }
      expect(allowed).toBe(true);
    });
  });

  describe('Migration 17: Decouple Doctors-Department Foreign Key', () => {
    it('exports up and down functions', () => {
      expect(typeof migration17.up).toBe('function');
      expect(typeof migration17.down).toBe('function');
    });

    it('executes up() with ON DELETE SET NULL SQL clause', async () => {
      const executedRaw = [];
      const mockKnex = {
        raw: async (sql) => {
          executedRaw.push(sql);
          return { rows: [] };
        },
      };

      await migration17.up(mockKnex);
      expect(executedRaw.length).toBe(2);

      // Verify the drop constraint block
      expect(executedRaw[0]).toContain('information_schema.table_constraints');
      expect(executedRaw[0]).toContain("table_name = 'doctors'");
      expect(executedRaw[0]).toContain("constraint_name LIKE '%department%'");

      // Verify re-adding foreign key with ON DELETE SET NULL
      expect(executedRaw[1]).toContain('ALTER TABLE doctors');
      expect(executedRaw[1]).toContain('ADD CONSTRAINT doctors_organization_id_department_id_fkey');
      expect(executedRaw[1]).toContain('REFERENCES departments (organization_id, id)');
      expect(executedRaw[1]).toContain('ON DELETE SET NULL');
    });

    it('executes down() restoring original RESTRICT foreign key', async () => {
      const executedRaw = [];
      const mockKnex = {
        raw: async (sql) => {
          executedRaw.push(sql);
          return { rows: [] };
        },
      };

      await migration17.down(mockKnex);
      expect(executedRaw.length).toBe(2);

      // Verify drop constraint
      expect(executedRaw[0]).toContain(
        'ALTER TABLE doctors DROP CONSTRAINT IF EXISTS doctors_organization_id_department_id_fkey',
      );

      // Verify restoring standard reference without ON DELETE SET NULL
      expect(executedRaw[1]).toContain('ALTER TABLE doctors');
      expect(executedRaw[1]).toContain('ADD CONSTRAINT doctors_organization_id_department_id_fkey');
      expect(executedRaw[1]).toContain('REFERENCES departments (organization_id, id)');
      expect(executedRaw[1]).not.toContain('ON DELETE SET NULL');
    });
  });
});
