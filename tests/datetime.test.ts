import { describe, expect, it } from 'vitest';
import { parseDate, parseTime } from '../src/web/datetime.ts';

describe('parseTime (24h)', () => {
  it('accepts the ways people type a time', () => {
    expect(parseTime('12')).toBe('12:00');
    expect(parseTime('9')).toBe('09:00');
    expect(parseTime('930')).toBe('09:30');
    expect(parseTime('1415')).toBe('14:15');
    expect(parseTime('9:5')).toBe('09:05');
    expect(parseTime('21.15')).toBe('21:15');
    expect(parseTime(' 00:00 ')).toBe('00:00');
  });
  it('rejects what is not a time', () => {
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('12:60')).toBeNull();
    expect(parseTime('12 AM')).toBeNull();
    expect(parseTime('')).toBeNull();
  });
});

describe('parseDate (dd.mm.yyyy)', () => {
  it('accepts day-first dates', () => {
    expect(parseDate('21.10.2026')).toBe('2026-10-21');
    expect(parseDate('1.2.26')).toBe('2026-02-01');
    expect(parseDate('21/10/2026')).toBe('2026-10-21');
    expect(parseDate('21.10', 2027)).toBe('2027-10-21');
  });
  it('rejects impossible dates', () => {
    expect(parseDate('31.02.2026')).toBeNull();
    expect(parseDate('10/21/2026')).toBeNull();
    expect(parseDate('jutro')).toBeNull();
  });
});
