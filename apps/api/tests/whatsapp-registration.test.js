import { describe, expect, it } from 'vitest';
import { cleanName, parseDob } from '../src/modules/whatsapp/registration.js';

describe('cleanName', () => {
  it('tidies spacing and single-case words, keeps mixed-case words as typed', () => {
    expect(cleanName('  asha   verma ')).toBe('Asha Verma');
    expect(cleanName('ASHA VERMA')).toBe('Asha Verma');
    expect(cleanName("d'souza anil")).toBe("D'Souza Anil");
    expect(cleanName('asha deVerma')).toBe('Asha deVerma');
    expect(cleanName('ravi KUMAR')).toBe('Ravi Kumar');
    expect(cleanName('A')).toBeNull();
    expect(cleanName('Asha 2')).toBeNull();
  });
});

describe('parseDob', () => {
  it('accepts common Indian formats and rejects impossible dates', () => {
    expect(parseDob('15-08-1990', '2026-11-13')).toBe('1990-08-15');
    expect(parseDob('5/8/1990', '2026-11-13')).toBe('1990-08-05');
    expect(parseDob('15.08.1990', '2026-11-13')).toBe('1990-08-15');
    expect(parseDob('1990-08-15', '2026-11-13')).toBe('1990-08-15');
    expect(parseDob('31-02-1990', '2026-11-13')).toBeNull();
    expect(parseDob('01-01-2030', '2026-11-13')).toBeNull();
    expect(parseDob('yesterday', '2026-11-13')).toBeNull();
  });
});
