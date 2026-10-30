/**
 * The CostTable port: the price list the application prices usage records
 * against. A synchronous lookup; an unknown model is a result, not an
 * error.
 */

import type { ModelPrice } from '../domain/usage';

/**
 * The per-model prices. Deadline: none; the lookup is synchronous and must
 * return promptly, so the caller never waits on it. Failure: returns
 * available false with the reason when the model has no price; never
 * throws and never hangs.
 */
export interface CostTable {
  price(model: string): ModelPrice;
}
