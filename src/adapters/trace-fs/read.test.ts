import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

import { readTrace, runDir } from './read';

let base: string | undefined;

afterEach(() => {
  if (base !== undefined) rmSync(base, { recursive: true, force: true });
  base = undefined;
});

describe('runDir', () => {
  test('places the run directory under runs/', () => {
    expect(runDir('/tmp/runs-root', 'run-7')).toBe(join('/tmp/runs-root', 'runs', 'run-7'));
  });

  test('rejects a run id that is not a single safe path segment', () => {
    for (const unsafe of ['../escape', 'a/b', '.', '..', '', 'run id with spaces']) {
      expect(() => runDir('/tmp/runs-root', unsafe)).toThrow();
    }
  });
});

describe('readTrace of a run without a trace file', () => {
  test('returns an empty trace', () => {
    base = join(tmpdir(), `trace-fs-read-${Math.random().toString(36).slice(2)}`);
    mkdirSync(base, { recursive: true });

    expect(readTrace(base)).toEqual({ events: [], invalid: [] });
  });
});
