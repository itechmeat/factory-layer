import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

import { REDACTED, redactJson } from '../../domain/redact';
import type { TraceEvent } from '../../domain/trace-event';
import { TRACE_FILE_NAME, readTrace, runDir } from './read';
import { FileTraceSink } from './trace-fs';

const RUN_ID = 'run-sink';
const BASE_AT = '2026-10-30T10:00:00.000Z';

let base: string | undefined;

afterEach(() => {
  if (base !== undefined) rmSync(base, { recursive: true, force: true });
  base = undefined;
});

function newBase(): string {
  base = mkdtempSync(join(tmpdir(), 'trace-fs-sink-'));
  return base;
}

function runStarted(specName: string): TraceEvent {
  return { at: BASE_AT, runId: RUN_ID, type: 'run_started', specName };
}

describe('FileTraceSink', () => {
  test('appends every event as one JSON line and reads back in order', () => {
    const runsDir = newBase();
    const sink = new FileTraceSink(runDir(runsDir, RUN_ID));
    const events = Array.from({ length: 100 }, (_, i) => runStarted(`todo-cli-${i}`));

    for (const event of events) sink.emit(event);

    const text = readFileSync(join(runDir(runsDir, RUN_ID), TRACE_FILE_NAME), 'utf8');
    expect(text.split('\n').filter((line) => line.trim() !== '').length).toBe(100);

    const read = readTrace(runDir(runsDir, RUN_ID));
    expect(read.invalid).toEqual([]);
    expect(read.events).toEqual(events);
  });

  test('the run directory is private to the owner (0700) and the trace file too (0600)', () => {
    const runsDir = newBase();
    const directory = runDir(runsDir, RUN_ID);
    new FileTraceSink(directory).emit(runStarted('todo-cli'));
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, TRACE_FILE_NAME)).mode & 0o777).toBe(0o600);
  });

  test('reports a line that does not parse with its line number', () => {
    const runsDir = newBase();
    const sink = new FileTraceSink(runDir(runsDir, RUN_ID));
    const first = runStarted('todo-cli-0');
    const last = runStarted('todo-cli-1');

    sink.emit(first);
    appendFileSync(join(runDir(runsDir, RUN_ID), TRACE_FILE_NAME), 'not json at all\n', 'utf8');
    sink.emit(last);

    const read = readTrace(runDir(runsDir, RUN_ID));
    expect(read.events).toEqual([first, last]);
    expect(read.invalid.length).toBe(1);
    expect(read.invalid[0]?.line).toBe(2);
    expect(read.invalid[0]?.detail.length).toBeGreaterThan(0);
  });

  test('reports a JSON line that is not a valid event with its line number', () => {
    const runsDir = newBase();
    const sink = new FileTraceSink(runDir(runsDir, RUN_ID));
    const first = runStarted('todo-cli-0');

    sink.emit(first);
    appendFileSync(join(runDir(runsDir, RUN_ID), TRACE_FILE_NAME), '{"type":"no-such-variant"}\n', 'utf8');

    const read = readTrace(runDir(runsDir, RUN_ID));
    expect(read.events).toEqual([first]);
    expect(read.invalid.length).toBe(1);
    expect(read.invalid[0]?.line).toBe(2);
    expect(typeof read.invalid[0]?.detail).toBe('string');
  });

  test('redacts a secret in a nested detail string before writing', () => {
    const runsDir = newBase();
    const sink = new FileTraceSink(runDir(runsDir, RUN_ID));
    sink.setSecrets(['s3cr3t-token']);
    const event: TraceEvent = {
      at: BASE_AT,
      runId: RUN_ID,
      type: 'executor_event',
      kind: 'wake',
      trigger: 'node_finished',
      seq: 3,
      detail: 'output held s3cr3t-token inside',
    };

    sink.emit(event);

    const text = readFileSync(join(runDir(runsDir, RUN_ID), TRACE_FILE_NAME), 'utf8');
    expect(text).toContain(REDACTED);
    expect(text).not.toContain('s3cr3t-token');
    const read = readTrace(runDir(runsDir, RUN_ID));
    expect(read.invalid).toEqual([]);
    expect(read.events).toEqual([redactJson(event, ['s3cr3t-token'])]);
  });

  test('replaces the secret set from the next emit on', () => {
    const runsDir = newBase();
    const sink = new FileTraceSink(runDir(runsDir, RUN_ID));
    sink.setSecrets(['first-secret']);
    sink.setSecrets(['second-secret']);
    const event: TraceEvent = {
      at: BASE_AT,
      runId: RUN_ID,
      type: 'executor_failure',
      reason: 'first-secret and second-secret seen',
    };

    sink.emit(event);

    const text = readFileSync(join(runDir(runsDir, RUN_ID), TRACE_FILE_NAME), 'utf8');
    expect(text).toContain('first-secret');
    expect(text).not.toContain('second-secret');
  });

  test('a write that fails never throws: failures are counted and reported once', () => {
    const blocker = join(newBase(), 'file');
    mkdirSync(join(blocker, '..'), { recursive: true });
    writeFileSync(blocker, 'not a directory');
    const reported: string[] = [];
    const sink = new FileTraceSink(join(blocker, 'run'), (line) => reported.push(line));
    expect(() => sink.emit(runStarted('a'))).not.toThrow();
    expect(() => sink.emit(runStarted('b'))).not.toThrow();
    expect(sink.failedWrites).toBe(2);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('trace write failed');
  });
});
