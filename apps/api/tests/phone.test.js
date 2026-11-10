import { describe, expect, it } from 'vitest';
import { maskMobile, normalizeMobile } from '../src/core/phone.js';

describe('normalizeMobile', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['98765 43210', '+919876543210'],
    ['098765-43210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['+14155550123', '+14155550123'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeMobile(input)).toBe(expected);
  });

  it.each(['12345', '5876543210', 'abcdefghij', '', '+0123456789'])('rejects %s', (input) => {
    expect(normalizeMobile(input)).toBeNull();
  });
});

describe('maskMobile', () => {
  it('keeps only the last four digits', () => {
    expect(maskMobile('+919876543210')).toBe('+91 ••••••3210');
    expect(maskMobile(null)).toBeNull();
  });
});
