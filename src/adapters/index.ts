/**
 * Adapters layer: implementations of the ports over real systems (the Mozaik
 * brain, APB through `apb mcp`, OSB memory, the stdio MCP client, git, the
 * file-system trace, the report). Adapters may import the application, ports
 * and the domain, never the CLI.
 *
 * Today it holds only the system clock.
 */

import type { Clock } from '../ports/index';

/** `Clock` over the process wall clock. */
export const systemClock: Clock = { now: () => new Date() };
