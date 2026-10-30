import { describe, expect, test } from 'bun:test';

import { parseClockTime } from './clock-time';

/** 18:05 local time today, the start of every case here. */
function localNow(): Date {
  const now = new Date();
  now.setHours(18, 5, 0, 0);
  return now;
}

describe('parseClockTime', () => {
  test('HH:MM is that local time today', () => {
    const now = localNow();
    const expected = new Date(now);
    expected.setHours(19, 15, 0, 0);
    expect(parseClockTime('19:15', now)).toBe(expected.getTime());
  });

  test('an ISO 8601 instant with a zone is taken as written', () => {
    const now = new Date('2026-10-30T10:00:00Z');
    expect(parseClockTime('2026-10-30T19:15:00+02:00', now)).toBe(Date.parse('2026-10-30T17:15:00Z'));
  });

  test('a local time not after now is a range error', () => {
    const now = localNow();
    expect(() => parseClockTime('09:00', now)).toThrow(RangeError);
    expect(() => parseClockTime('18:05', now)).toThrow(RangeError);
  });

  test('an ISO instant in the past is a range error', () => {
    expect(() => parseClockTime('2026-10-30T09:00:00Z', new Date('2026-10-30T10:00:00Z'))).toThrow(RangeError);
  });

  test('garbage, an hour or minute out of range and an ISO time without a zone are range errors', () => {
    const now = localNow();
    for (const value of ['', 'soon', '24:00', '19:60', '7pm', '19:15:00', '2026-10-30T19:15:00', '2026-13-40T19:15:00Z']) {
      expect(() => parseClockTime(value, now)).toThrow(RangeError);
    }
  });
});
