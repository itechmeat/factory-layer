/**
 * Failure paths of the OSB run memory against the fake MCP server: the
 * refusal without the vault variables, a retried remember, an OSB refusal,
 * a note that never gets indexed,
 * unparsable and repeated hits in recall, an over-long query, an abort and a
 * call timeout.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeSpec, type Spec } from '../../domain/spec';
import { MemoryError, type RunOutcomeRecord } from '../../ports/memory';
import { OsbMemory, OsbMemoryConfigError, type OsbMemoryOptions } from './osb-memory';
import { SMOKE_NOTES_PREFIX } from './run-note';

const FIXTURE = join(import.meta.dir, '../../../tests/fixtures/fake-mcp-server.ts');
const ENV = { FACTORY_OSB_CONFIG: '/nowhere/config.yaml', FACTORY_OSB_VAULT: '/nowhere/vault' };
const dir = mkdtempSync(join(tmpdir(), 'osb-memory-'));
let stores = 0;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const RECORD: RunOutcomeRecord = {
  runId: 'run-1',
  specName: 'wordfreq',
  outcome: 'succeeded',
  planSummary: 'Two tasks: parse the text file, then count and print the top words.',
  tasks: [{ taskId: 'count', revision: 1, integrated: true, attempts: 2 }],
  failedCheckIds: [],
  durationMs: 61_000,
};

/** A memory over the fake server with its own fresh fake vault. */
function memory(flags: string[] = [], options: OsbMemoryOptions = {}): OsbMemory {
  stores += 1;
  const store = join(dir, `vault-${stores}.json`);
  return new OsbMemory({
    env: ENV,
    launcher: { command: process.execPath, args: [FIXTURE, '--osb-store', store, ...flags] },
    closeGraceMs: 500,
    indexWaitMs: 300,
    ...options,
  });
}

/** A spec whose text is `markdown`. */
function spec(markdown: string): Spec {
  return makeSpec({ markdown, sourceFile: 'wordfreq.md' });
}

function live(): AbortSignal {
  return new AbortController().signal;
}

async function failure(call: Promise<unknown>): Promise<MemoryError> {
  const error: unknown = await call.catch((caught: unknown) => caught);
  if (!(error instanceof MemoryError)) throw new Error(`expected a memory error, got ${String(error)}`);
  return error;
}

describe('configuration', () => {
  test.each(['FACTORY_OSB_VAULT', 'FACTORY_OSB_CONFIG'])('refuses to start without %s and names it', (variable) => {
    const env = { ...ENV, [variable]: '' };
    expect(() => new OsbMemory({ env })).toThrow(OsbMemoryConfigError);
    expect(() => new OsbMemory({ env })).toThrow(variable);
  });
});

describe('remember', () => {
  test('a retry of the run, stamped later, is a duplicate and not an error', async () => {
    let clock = Date.parse('2026-10-30T10:00:00Z');
    const osb = memory([], { now: () => new Date((clock += 1000)) });
    expect(await osb.writeOutcome(RECORD, live())).toBe('written');
    expect(await osb.writeOutcome(RECORD, live())).toBe('duplicate');
  });

  test('a note that never becomes searchable is still written once the index wait ends', async () => {
    const started = performance.now();
    expect(await memory(['--osb-unindexed'], { indexWaitMs: 300 }).writeOutcome(RECORD, live())).toBe('written');
    expect(performance.now() - started).toBeLessThan(3000);
  });

  test('a search error while waiting for the index does not fail a written note', async () => {
    expect(await memory(['--osb-search-error']).writeOutcome(RECORD, live())).toBe('written');
  });

  test('an abort while waiting for the index keeps the written note remembered', async () => {
    const controller = new AbortController();
    const call = memory(['--osb-unindexed'], { indexWaitMs: 5000 }).writeOutcome(RECORD, controller.signal);
    setTimeout(() => controller.abort(), 700);
    expect(await call).toBe('written');
  });

  test('a refusal is a failure carrying the server message', async () => {
    const error = await failure(memory(['--osb-refuse', 'invalid_document']).writeOutcome(RECORD, live()));
    expect(error.reason).toBe('failed');
    expect(error.message).toContain('refused');
  });
});

describe('recall', () => {
  test('skips unparsable notes, returns one run per note and cuts the query to the search limit', async () => {
    const osb = memory([], { now: () => new Date('2026-10-30T10:00:00Z') });
    await osb.writeOutcome(RECORD, live());
    await osb.writeOutcome({ ...RECORD, runId: 'run-2', outcome: 'partial' }, live());
    const runs = await osb.recall(spec('word '.repeat(1000)), 5, live());
    expect(runs).toEqual([
      { specName: 'wordfreq', outcome: 'succeeded', summary: RECORD.planSummary, at: '2026-10-30T10:00:00.000Z' },
      { specName: 'wordfreq', outcome: 'partial', summary: RECORD.planSummary, at: '2026-10-30T10:00:00.000Z' },
    ]);
  });

  test('a note that cannot be read is skipped, the others still come back', async () => {
    const osb = memory(['--osb-expand-fail', 'run-2']);
    await osb.writeOutcome(RECORD, live());
    await osb.writeOutcome({ ...RECORD, runId: 'run-2' }, live());
    const runs = await osb.recall(spec('wordfreq'), 5, live());
    expect(runs).toHaveLength(1);
  });

  test('recall never returns notes written under the smoke prefix, nor legacy smoke notes', async () => {
    const store = join(dir, 'vault-smoke.json');
    const options = {
      env: ENV,
      launcher: { command: process.execPath, args: [FIXTURE, '--osb-store', store] },
      closeGraceMs: 500,
      indexWaitMs: 300,
    };
    await new OsbMemory({ ...options, notesPrefix: SMOKE_NOTES_PREFIX }).writeOutcome(RECORD, live());
    await new OsbMemory(options).writeOutcome({ ...RECORD, runId: 'smoke-1700000000000' }, live());
    expect(await new OsbMemory(options).recall(spec('wordfreq'), 5, live())).toEqual([]);
  });

  test('a recall under the smoke prefix returns the smoke notes it wrote', async () => {
    const smoke = memory([], { notesPrefix: SMOKE_NOTES_PREFIX });
    await smoke.writeOutcome({ ...RECORD, runId: 'smoke-1700000000000' }, live());
    expect(await smoke.recall(spec('wordfreq'), 5, live())).toHaveLength(1);
  });

  test('returns at most the requested number of runs', async () => {
    const osb = memory();
    await osb.writeOutcome(RECORD, live());
    await osb.writeOutcome({ ...RECORD, runId: 'run-2' }, live());
    expect(await osb.recall(spec('wordfreq'), 1, live())).toHaveLength(1);
  });

  test('an aborted signal ends the wait at once', async () => {
    const controller = new AbortController();
    const call = memory(['--osb-hang']).recall(spec('wordfreq'), 3, controller.signal);
    setTimeout(() => controller.abort(), 300);
    const started = performance.now();
    const error = await failure(call);
    expect(error.reason).toBe('cancelled');
    expect(performance.now() - started).toBeLessThan(1500);
  });

  test('an already aborted signal starts nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await failure(memory().recall(spec('wordfreq'), 3, controller.signal))).reason).toBe('cancelled');
  });

  test('a search that never answers fails at the call timeout', async () => {
    const error = await failure(memory(['--osb-hang'], { callTimeoutMs: 300 }).recall(spec('wordfreq'), 3, live()));
    expect(error.reason).toBe('timeout');
  });
});
