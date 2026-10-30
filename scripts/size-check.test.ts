import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkSizes, HARD_LIMIT, WARN_LIMIT } from './size-check';

const lines = (count: number): string => 'x\n'.repeat(count);

describe('checkSizes', () => {
  test('warns past the smell, fails past the limit, skips tests', () => {
    const dir = mkdtempSync(join(import.meta.dir, '.size-check-'));
    try {
      mkdirSync(join(dir, 'layer'));
      writeFileSync(join(dir, 'layer', 'ok.ts'), lines(WARN_LIMIT));
      writeFileSync(join(dir, 'layer', 'smell.ts'), lines(WARN_LIMIT + 1));
      writeFileSync(join(dir, 'big.ts'), lines(HARD_LIMIT + 1));
      writeFileSync(join(dir, 'big.test.ts'), lines(HARD_LIMIT + 1));
      const report = checkSizes(dir);
      expect(report.warnings).toEqual([{ file: join('layer', 'smell.ts'), lines: WARN_LIMIT + 1 }]);
      expect(report.violations).toEqual([{ file: 'big.ts', lines: HARD_LIMIT + 1 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
