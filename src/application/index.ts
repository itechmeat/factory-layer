/**
 * Application layer: the factory state machine and its use cases. It talks to
 * the outside only through ports and may import ports and the domain, never
 * an adapter or the CLI.
 *
 * Today it holds only the status line the CLI prints.
 */

import { PRODUCT } from '../domain/index';
import type { Clock } from '../ports/index';

/** One line naming the product, its stage and the current time. */
export function statusLine(clock: Clock): string {
  return `${PRODUCT.name} (${PRODUCT.stage}) ${clock.now().toISOString()}`;
}
