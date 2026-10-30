/**
 * Boundary failures of the price file: an entry without its source is
 * refused at load, an unknown model prices as unavailable, and the checked-in
 * file itself loads.
 */

import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadPriceFile, PRICE_FILE, PriceFileError } from './price-file';

const dir = mkdtempSync(join(tmpdir(), 'prices-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('the checked-in price file loads, and a model it does not list is unavailable, named', () => {
  const table = loadPriceFile(join(import.meta.dir, '../../..', PRICE_FILE));
  expect(table.price('claude-sonnet-5-5')).toMatchObject({ available: true });
  expect(table.price('GLM-5.3-Flash')).toMatchObject({ available: true });
  const unknown = table.price('no-such-model');
  expect(unknown.available).toBe(false);
  expect(!unknown.available && unknown.reason).toContain('no-such-model');
});

test('an entry without its source is refused at load', () => {
  const file = join(dir, 'prices.json');
  const entry = {
    available: true,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 1,
    cacheReadUsdPerMillion: 0,
    cacheWriteUsdPerMillion: 0,
    date: '2026-10-30',
  };
  writeFileSync(file, JSON.stringify({ models: { m: entry } }));
  expect(() => loadPriceFile(file)).toThrow(PriceFileError);
  expect(() => loadPriceFile(file)).toThrow(/source/);
});
