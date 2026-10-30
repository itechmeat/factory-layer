import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { hasHeader, missingHeaders } from './header-check';

describe('hasHeader', () => {
  test('accepts a leading JSDoc block, after a shebang too', () => {
    expect(hasHeader('/**\n * Does one thing.\n */\nexport {};\n')).toBe(true);
    expect(hasHeader('#!/usr/bin/env bun\n/** Entry. */\n')).toBe(true);
  });

  test('rejects code or a plain comment first', () => {
    expect(hasHeader('export const a = 1;\n')).toBe(false);
    expect(hasHeader('// not a header\n')).toBe(false);
  });
});

describe('missingHeaders', () => {
  test('names modules without a header and skips tests', () => {
    const dir = mkdtempSync(join(import.meta.dir, '.header-check-'));
    try {
      writeFileSync(join(dir, 'good.ts'), '/** Good. */\nexport {};\n');
      writeFileSync(join(dir, 'bad.ts'), 'export {};\n');
      writeFileSync(join(dir, 'bad.test.ts'), 'export {};\n');
      expect(missingHeaders([dir])).toEqual([join(dir, 'bad.ts')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
