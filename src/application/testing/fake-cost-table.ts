/**
 * A scriptable `CostTable` for tests: every model is priced by default at
 * 3 USD per million input tokens, 15 USD per million output tokens, 0.3 USD
 * per million cache read tokens and 3.75 USD per million cache write tokens,
 * `setPrice` overrides one model (including an unavailable price), and the
 * fake holds no state beyond the scripted prices.
 */

import type { ModelPrice } from '../../domain';
import type { CostTable } from '../../ports';

/** The input price of an unscripted model, USD per million tokens. */
export const FAKE_DEFAULT_INPUT_USD_PER_MILLION = 3;

/** The output price of an unscripted model, USD per million tokens. */
export const FAKE_DEFAULT_OUTPUT_USD_PER_MILLION = 15;

/** The cache read price of an unscripted model, USD per million tokens. */
export const FAKE_DEFAULT_CACHE_READ_USD_PER_MILLION = 0.3;

/** The cache write price of an unscripted model, USD per million tokens. */
export const FAKE_DEFAULT_CACHE_WRITE_USD_PER_MILLION = 3.75;

export class FakeCostTable implements CostTable {
  private readonly prices = new Map<string, ModelPrice>();

  /** Scripts the price of one model; an unavailable price scripts the unknown-model result. */
  setPrice(model: string, price: ModelPrice): void {
    this.prices.set(model, price);
  }

  price(model: string): ModelPrice {
    const scripted = this.prices.get(model);
    return (
      scripted ?? {
        available: true,
        inputUsdPerMillion: FAKE_DEFAULT_INPUT_USD_PER_MILLION,
        outputUsdPerMillion: FAKE_DEFAULT_OUTPUT_USD_PER_MILLION,
        cacheReadUsdPerMillion: FAKE_DEFAULT_CACHE_READ_USD_PER_MILLION,
        cacheWriteUsdPerMillion: FAKE_DEFAULT_CACHE_WRITE_USD_PER_MILLION,
      }
    );
  }
}
