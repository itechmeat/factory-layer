import { expect, test } from 'bun:test';

import { connectMcpStdio } from '../../src/adapters/mcp-stdio/client';
import { EXIT_CONFIRMATION_MS, isProcessAlive } from '../../src/adapters/mcp-stdio/process-teardown';
import { requireBinary, requireEnv } from './support/prerequisites';

/** The memory link must be proven within this budget, in milliseconds. */
const MEMORY_SMOKE_TIMEOUT_MS = 60_000;

/** Budget for starting `o2b mcp` and the handshake, in milliseconds. */
const MEMORY_CONNECT_TIMEOUT_MS = 15_000;

/** Budget for listing the tools, every page included, in milliseconds. */
const MEMORY_LIST_TIMEOUT_MS = 20_000;

/** Grace period of the close before SIGKILL, in milliseconds. */
const MEMORY_CLOSE_GRACE_MS = 5000;

/** Time kept free for the test runner and the assertions, in milliseconds. */
const MEMORY_RESERVE_MS = 10_000;

test('the memory smoke budgets, teardown included, fit inside its deadline', () => {
  const worstCase = MEMORY_CONNECT_TIMEOUT_MS + MEMORY_LIST_TIMEOUT_MS + MEMORY_CLOSE_GRACE_MS + EXIT_CONFIRMATION_MS;
  expect(worstCase + MEMORY_RESERVE_MS).toBeLessThanOrEqual(MEMORY_SMOKE_TIMEOUT_MS);
});

test(
  'OSB MCP server on the factory vault: handshake, a non-empty tool list, no leftover process',
  async () => {
    const vault = requireEnv('FACTORY_OSB_VAULT');
    const config = requireEnv('FACTORY_OSB_CONFIG');
    const o2b = requireBinary('o2b');

    const client = await connectMcpStdio(
      { command: o2b, args: ['mcp', '--config', config, '--vault', vault] },
      { connectTimeoutMs: MEMORY_CONNECT_TIMEOUT_MS, closeGraceMs: MEMORY_CLOSE_GRACE_MS },
    );
    try {
      expect(client.serverInfo.name).not.toBe('');
      const tools = await client.listTools({ timeoutMs: MEMORY_LIST_TIMEOUT_MS });
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
    expect(isProcessAlive(client.pid)).toBe(false);
  },
  MEMORY_SMOKE_TIMEOUT_MS,
);
