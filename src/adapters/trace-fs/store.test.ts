import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

import type { ExecutorRunRef, RunState } from '../../domain/run-state';
import { aRunState } from '../../application/testing/builders';
import { FakeClock } from '../../application/testing/fake-clock';
import { StorageError } from '../../ports/run-store';
import { TRACE_FILE_NAME, readTrace, runDir } from './read';
import { FileRunStore } from './store';

const RUN_ID = 'run-store';
const BASE_AT = '2026-10-30T10:00:00.000Z';
const TOKEN = 'supervisor-token-xyz';

let base: string | undefined;

afterEach(() => {
  if (base !== undefined) {
    // A failed-save test leaves the root read-only; restore so the cleanup can delete it.
    chmodSync(base, 0o700);
    rmSync(base, { recursive: true, force: true });
  }
  base = undefined;
});

function newBase(): string {
  base = mkdtempSync(join(tmpdir(), 'trace-fs-store-'));
  return base;
}

function stateFile(runsDir: string, runId: string): string {
  return join(runDir(runsDir, runId), 'state.json');
}

function stateWithToken(runId: string): RunState {
  const runRef: ExecutorRunRef = {
    executorRunId: 'exec-1',
    taskId: 'task-1',
    revision: 1,
    attempt: 1,
    dispatchKey: 'factory-1|task-1|r1|a1',
    playbook: 'playbook-feature',
    tree: '/work/todo-cli/.trees/task-1-r1',
    role: 'task',
    supervisorToken: TOKEN,
    cursor: 0,
    lastEventAt: BASE_AT,
    state: 'live',
  };
  return aRunState({ runId, runs: { 'exec-1': runRef } });
}

describe('FileRunStore.save', () => {
  test('writes the state atomically with mode 0600 and leaves no temp file', async () => {
    const runsDir = newBase();
    const store = new FileRunStore(runsDir, new FakeClock(BASE_AT));
    const state = stateWithToken(RUN_ID);

    await store.save(state);

    const saved = statSync(stateFile(runsDir, RUN_ID));
    expect(saved.mode & 0o777).toBe(0o600);
    expect(readdirSync(runDir(runsDir, RUN_ID))).toEqual(['state.json']);
  });

  test('rejects with StorageError when the directory cannot be written', async () => {
    const runsDir = newBase();
    const store = new FileRunStore(runsDir, new FakeClock(BASE_AT));
    chmodSync(runsDir, 0o500);
    try {
      await expect(store.save(stateWithToken(RUN_ID))).rejects.toBeInstanceOf(StorageError);
    } finally {
      chmodSync(runsDir, 0o700);
    }
  });
});

describe('FileRunStore.load', () => {
  test('round trips a saved state', async () => {
    const runsDir = newBase();
    const store = new FileRunStore(runsDir, new FakeClock(BASE_AT));
    const state = stateWithToken(RUN_ID);

    await store.save(state);

    await expect(store.load(RUN_ID)).resolves.toEqual(state);
  });

  test('resolves null when the run has no stored state', async () => {
    const store = new FileRunStore(newBase(), new FakeClock(BASE_AT));

    await expect(store.load('run-absent')).resolves.toBe(null);
  });

  test('rejects with StorageError naming the path when the state does not validate', async () => {
    const runsDir = newBase();
    const store = new FileRunStore(runsDir, new FakeClock(BASE_AT));
    mkdirSync(runDir(runsDir, RUN_ID), { recursive: true });
    writeFileSync(stateFile(runsDir, RUN_ID), '{"schemaVersion":2}\n', 'utf8');

    const failure = await store.load(RUN_ID).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(StorageError);
    if (failure instanceof StorageError) {
      expect(failure.message).toContain('state.json');
    }
  });

  test('rejects with StorageError when the state file is not JSON', async () => {
    const runsDir = newBase();
    const store = new FileRunStore(runsDir, new FakeClock(BASE_AT));
    mkdirSync(runDir(runsDir, RUN_ID), { recursive: true });
    writeFileSync(stateFile(runsDir, RUN_ID), 'not json at all', 'utf8');

    await expect(store.load(RUN_ID)).rejects.toBeInstanceOf(StorageError);
  });
});

describe('FileRunStore.appendIntervention', () => {
  test('writes an intervention_recorded line into the run trace and returns it', async () => {
    const runsDir = newBase();
    const store = new FileRunStore(runsDir, new FakeClock(BASE_AT));

    const recorded = await store.appendIntervention(RUN_ID, 'pause the run');

    expect(recorded.note).toBe('pause the run');
    const read = readTrace(runDir(runsDir, RUN_ID));
    expect(read.invalid).toEqual([]);
    expect(read.events.length).toBe(1);
    expect(read.events[0]).toEqual({ at: recorded.at, runId: RUN_ID, type: 'intervention_recorded', note: 'pause the run' });
  });

  test('stamps the note with the injected clock and redacts the registered secrets', async () => {
    const runsDir = newBase();
    const store = new FileRunStore(runsDir, new FakeClock(BASE_AT));
    store.setSecrets(['hunter2']);

    const recorded = await store.appendIntervention(RUN_ID, 'retry with password hunter2');

    expect(recorded).toEqual({ at: BASE_AT, note: 'retry with password [redacted]' });
    const traceText = readFileSync(join(runDir(runsDir, RUN_ID), TRACE_FILE_NAME), 'utf8');
    expect(traceText).not.toContain('hunter2');
    expect(readTrace(runDir(runsDir, RUN_ID)).events[0]).toEqual({
      at: BASE_AT,
      runId: RUN_ID,
      type: 'intervention_recorded',
      note: 'retry with password [redacted]',
    });
  });

  test('records interventions from another store handle on the same runs dir', async () => {
    const runsDir = newBase();
    const first = new FileRunStore(runsDir, new FakeClock(BASE_AT));
    const second = new FileRunStore(runsDir, new FakeClock(BASE_AT));

    await first.appendIntervention(RUN_ID, 'from the first handle');
    await second.appendIntervention(RUN_ID, 'from the second handle');

    const read = readTrace(runDir(runsDir, RUN_ID));
    expect(read.events.map((event) => (event.type === 'intervention_recorded' ? event.note : ''))).toEqual([
      'from the first handle',
      'from the second handle',
    ]);
  });

  test('never writes a supervisor token into the trace, only into the state', async () => {
    const runsDir = newBase();
    const store = new FileRunStore(runsDir, new FakeClock(BASE_AT));

    await store.save(stateWithToken(RUN_ID));
    await store.appendIntervention(RUN_ID, 'an intervention');

    const traceText = readFileSync(join(runDir(runsDir, RUN_ID), TRACE_FILE_NAME), 'utf8');
    expect(traceText).not.toContain(TOKEN);
    expect(readFileSync(stateFile(runsDir, RUN_ID), 'utf8')).toContain(TOKEN);
  });
});
