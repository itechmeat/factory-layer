/**
 * The `CostTable` over a checked-in price file (`config/prices.json`): per
 * model, the input, output, cache read and cache write prices in USD per
 * million tokens, each entry with the date it was read and the URL it was
 * read from. The file is validated with Zod when loaded; a model it does not
 * list prices as unavailable, naming the model, so nothing is invented.
 * Lookup ignores case, as providers and agent CLIs differ in how they
 * spell a model id.
 */

import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { type ModelPrice, ModelPriceSchema } from '../../domain/usage';
import type { CostTable } from '../../ports/cost-table';

/** The price file, relative to the repository root. */
export const PRICE_FILE = 'config/prices.json';

const PriceEntrySchema = z.intersection(
  ModelPriceSchema,
  z.object({ date: z.iso.date(), source: z.url({ protocol: /^https$/ }), note: z.string().optional() }),
);

const PriceFileSchema = z.object({ models: z.record(z.string().min(1), PriceEntrySchema) });

/** The price file could not be read or does not match its schema. */
export class PriceFileError extends Error {
  constructor(file: string, problem: string) {
    super(`price file ${file}: ${problem}`);
    this.name = 'PriceFileError';
  }
}

/** Prices by model from a validated price file. */
export class PriceFileCostTable implements CostTable {
  readonly #prices: ReadonlyMap<string, ModelPrice>;
  readonly #file: string;

  constructor(prices: ReadonlyMap<string, ModelPrice>, file: string) {
    this.#prices = new Map([...prices].map(([model, price]) => [model.toLowerCase(), price]));
    this.#file = file;
  }

  price(model: string): ModelPrice {
    return this.#prices.get(model.toLowerCase()) ?? { available: false, reason: `no price for model ${model} in ${this.#file}` };
  }
}

/** Reads and validates `file`; throws `PriceFileError` naming the problem. */
export function loadPriceFile(file: string): PriceFileCostTable {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new PriceFileError(file, error instanceof Error ? error.message : String(error));
  }
  const parsed = PriceFileSchema.safeParse(raw);
  if (!parsed.success) throw new PriceFileError(file, z.prettifyError(parsed.error));
  const prices = new Map<string, ModelPrice>();
  for (const [model, entry] of Object.entries(parsed.data.models)) {
    if (entry.available) {
      const { inputUsdPerMillion, outputUsdPerMillion, cacheReadUsdPerMillion, cacheWriteUsdPerMillion } = entry;
      prices.set(model, { available: true, inputUsdPerMillion, outputUsdPerMillion, cacheReadUsdPerMillion, cacheWriteUsdPerMillion });
    } else {
      prices.set(model, { available: false, reason: entry.reason });
    }
  }
  return new PriceFileCostTable(prices, file);
}
