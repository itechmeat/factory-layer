/**
 * The Mozaik warning filter: an end-to-end run cannot show that a line was
 * dropped, so this pins that the known line is dropped and every other
 * warning still reaches the console.
 */

import { describe, expect, test } from 'bun:test';

import { filterMozaikWarning, MOZAIK_NO_KEY_WARNING } from './console-filter';

describe('filterMozaikWarning', () => {
  test('drops the Mozaik no-key line and passes every other warning through', () => {
    const seen: unknown[][] = [];
    const sink = { warn: (...args: unknown[]): void => void seen.push(args) };
    filterMozaikWarning(sink);
    sink.warn(`${MOZAIK_NO_KEY_WARNING}, telemetry disabled`);
    sink.warn('provider rate-limited', 429);
    expect(seen).toEqual([['provider rate-limited', 429]]);
  });
});
