import { describe, expect, it } from 'vitest';
import {
  findPossibleDuplicates,
  nameSimilarity,
  normalizeName,
} from '../src/modules/patients/matching.js';

const settings = { nameSimilarityThreshold: 0.85, matchRequiresDob: true };
const subject = { fullName: 'Asha Verma', dateOfBirth: '1990-04-01', contactIds: ['c1'] };

describe('name normalization and similarity', () => {
  it('ignores case, punctuation, honorifics and word order', () => {
    expect(normalizeName('  Mrs. ASHA   verma ')).toBe('asha verma');
    expect(nameSimilarity('Verma Asha', 'asha verma')).toBe(1);
    expect(nameSimilarity('Asha Verma', 'Aasha Verma')).toBeGreaterThan(0.85);
    expect(nameSimilarity('Asha Verma', 'Rohan Verma')).toBeLessThan(0.85);
  });
});

describe('findPossibleDuplicates', () => {
  it('flags a similar name with the same date of birth', () => {
    const m = findPossibleDuplicates(
      subject,
      [{ id: 'p1', fullName: 'Aasha Verma', dateOfBirth: '1990-04-01', contactIds: [] }],
      settings,
    );
    expect(m).toHaveLength(1);
    expect(m[0].reasons).toEqual(['similar_name', 'same_date_of_birth']);
  });

  it('never matches on a shared phone number alone (families share numbers)', () => {
    const m = findPossibleDuplicates(
      subject,
      [{ id: 'p2', fullName: 'Rohan Verma', dateOfBirth: '2015-01-01', contactIds: ['c1'] }],
      settings,
    );
    expect(m).toEqual([]);
  });

  it('treats different dates of birth as different people', () => {
    const m = findPossibleDuplicates(
      subject,
      [{ id: 'p3', fullName: 'Asha Verma', dateOfBirth: '1991-04-01', contactIds: ['c1'] }],
      settings,
    );
    expect(m).toEqual([]);
  });

  it('uses a shared contact plus the same name when a date of birth is missing', () => {
    const m = findPossibleDuplicates(
      { ...subject, dateOfBirth: null },
      [{ id: 'p4', fullName: 'Asha Verma', dateOfBirth: null, contactIds: ['c1'] }],
      settings,
    );
    expect(m[0]).toMatchObject({ patientId: 'p4', reasons: ['same_name', 'shared_contact'] });
    expect(
      findPossibleDuplicates(
        { ...subject, dateOfBirth: null, contactIds: [] },
        [{ id: 'p4', fullName: 'Asha Verma', dateOfBirth: null, contactIds: ['c1'] }],
        settings,
      ),
    ).toEqual([]);
  });

  it('respects the configured threshold', () => {
    const strict = { ...settings, nameSimilarityThreshold: 1 };
    expect(
      findPossibleDuplicates(
        subject,
        [{ id: 'p1', fullName: 'Aasha Verma', dateOfBirth: '1990-04-01', contactIds: [] }],
        strict,
      ),
    ).toEqual([]);
  });
});
