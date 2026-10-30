import { describe, expect, test } from 'bun:test';

import { main } from './index';

describe('main', () => {
  test('prints the status line and exits 0', () => {
    const lines: string[] = [];
    expect(main((line) => lines.push(line))).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith('factory-layer (under construction) ');
  });
});
