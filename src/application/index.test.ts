import { describe, expect, test } from 'bun:test';

import type { Clock } from '../ports/index';
import { statusLine } from './index';

describe('statusLine', () => {
  test('prints the product, its stage and the clock time', () => {
    const clock: Clock = { now: () => new Date('2026-01-02T03:04:05.000Z') };
    expect(statusLine(clock)).toBe('factory-layer (under construction) 2026-01-02T03:04:05.000Z');
  });
});
