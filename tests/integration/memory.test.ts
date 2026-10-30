import { expect, test } from 'bun:test';

import { connectMcpStdio } from '../../src/adapters/mcp-stdio/client';
import { EXIT_CONFIRMATION_MS, isProcessAlive } from '../../src/adapters/mcp-stdio/process-teardown';
import { OsbMemory } from '../../src/adapters/memory-osb/osb-memory';
import { SMOKE_NOTES_PREFIX } from '../../src/adapters/memory-osb/run-note';
import { makeSpec } from '../../src/domain/spec';
import type { RecalledRun } from '../../src/ports/memory';
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

/** The remember-and-recall smoke must finish within this budget, in milliseconds. */
const RECALL_SMOKE_TIMEOUT_MS = 60_000;

/** How long recall is retried while OSB indexes the new note, in milliseconds. */
const RECALL_INDEXING_WINDOW_MS = 10_000;

/** Pause between two recall attempts, in milliseconds. */
const RECALL_RETRY_PAUSE_MS = 1000;

/** The spec worded differently from the remembered plan summary. */
const REWORDED_SPEC =
  'A command line program that tallies how many times every word appears in the given text files and prints the most common ones first.';

test(
  'run memory on the factory vault: a remembered wordfreq run is recalled by a reworded spec, and a retry is a duplicate',
  async () => {
    requireEnv('FACTORY_OSB_VAULT');
    requireEnv('FACTORY_OSB_CONFIG');
    const o2b = requireBinary('o2b');
    // Fake notes go under the smoke prefix: a real run's recall never sees them. The smoke reads them back with the same prefix.
    const memory = new OsbMemory({ launcher: { command: o2b }, notesPrefix: SMOKE_NOTES_PREFIX });
    const runId = `smoke-${Date.now()}`;
    const record = {
      runId,
      specName: 'wordfreq',
      outcome: 'succeeded' as const,
      planSummary: `Run ${runId}: a word frequency counter CLI built as a tokenizer task and a ranking task, counting words in text files.`,
      tasks: [
        { taskId: 'tokenizer', revision: 1, integrated: true, attempts: 1 },
        { taskId: 'ranking-cli', revision: 1, integrated: true, attempts: 2 },
      ],
      failedCheckIds: [],
      durationMs: 420_000,
    };
    const signal = AbortSignal.timeout(RECALL_SMOKE_TIMEOUT_MS);

    expect(await memory.writeOutcome(record, signal)).toBe('written');
    expect(await memory.writeOutcome(record, signal)).toBe('duplicate');

    const deadline = performance.now() + RECALL_INDEXING_WINDOW_MS;
    let found: RecalledRun | undefined;
    while (found === undefined && performance.now() < deadline) {
      // The vault keeps every earlier smoke record with the same wording, so the reworded spec also names this run's id to rank its record first.
      const runs = await memory.recall(
        makeSpec({ markdown: `${REWORDED_SPEC} Reference: ${runId}.`, sourceFile: 'word-tally.md' }),
        10,
        signal,
      );
      found = runs.find((run) => run.summary === record.planSummary);
      if (found === undefined) await Bun.sleep(RECALL_RETRY_PAUSE_MS);
    }
    expect(found).toMatchObject({ specName: 'wordfreq', outcome: 'succeeded' });
  },
  RECALL_SMOKE_TIMEOUT_MS,
);
