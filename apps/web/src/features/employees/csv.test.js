import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv, toRecords } from './csv';

describe('CSV reading', () => {
  it('handles quotes, commas, CRLF and a byte-order mark', () => {
    const text = '﻿Full Name,Weekly Off\r\n"Asha, Demo","Sat, Sun"\r\n"Say ""hi""",Sun\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ['Full Name', 'Weekly Off'],
      ['Asha, Demo', 'Sat, Sun'],
      ['Say "hi"', 'Sun'],
    ]);
    expect(toRecords(parseCsv(text))[0]).toEqual({
      'Full Name': 'Asha, Demo',
      'Weekly Off': 'Sat, Sun',
    });
  });

  it('turns spreadsheet dates and numbers into text', () => {
    const rows = toRecords([
      ['Mobile', 'Joining Date'],
      [9000000501, new Date('2025-06-15T00:00:00Z')],
    ]);
    expect(rows[0]).toEqual({ Mobile: '9000000501', 'Joining Date': '2025-06-15' });
  });

  it('writes CSV that reads back the same', () => {
    const data = [
      ['a', 'b,c'],
      ['"q"', 'x'],
    ];
    expect(parseCsv(toCsv(data))).toEqual(data);
  });
});
