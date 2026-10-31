/**
 * The hidden run over the fake factory: two deliveries pass end to end, a
 * built delivery becomes committable while a missing import fails its
 * startup, a factory killed at the hard deadline is reported and still
 * prints the table (by the report time, even when it ignores SIGTERM), a factory that cannot start is named, and a bad time
 * order fails before anything starts; plus the command line parsing and
 * the two-step Ctrl-C.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { factoryCell, installInterrupt, parseCommandLine, parseTimes, runHidden } from './hidden-run';
import { realGit, type HiddenOptions } from './hidden-run-steps';
import { FAKE_FACTORY_PATH, writeFakeSpec } from './testing/hidden-fake-factory';

const repos: string[] = [];

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'hidden-run-repo-'));
  repos.push(repo);
  writeFileSync(join(repo, '.gitignore'), ['dist/', 'node_modules/', '!hidden/**', 'hidden/**/node_modules/'].join('\n') + '\n');
  const initialized = Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: repo, stdout: 'ignore', stderr: 'ignore' });
  if (initialized.exitCode !== 0) throw new Error('git init failed in the test repository');
  return repo;
}

afterAll(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
});

function optionsFor(repo: string, specModes: readonly string[], write: (line: string) => void): HiddenOptions {
  const now = Date.now();
  return {
    specPaths: specModes.map((mode) => writeFakeSpec(repo, mode)),
    cutoff: '19:15',
    hardDeadlineMs: now + 60_000,
    reportByMs: now + 120_000,
    repoRoot: repo,
    hiddenDir: join(repo, 'hidden'),
    factoryCommand: ['bun', FAKE_FACTORY_PATH],
    taskConcurrency: 2,
    replace: false,
    termGraceMs: 1_000,
    git: realGit,
    write,
  };
}

describe('runHidden', () => {
  test('two deliveries pass end to end', async () => {
    const repo = makeRepo();
    const writes: string[] = [];
    const gitArgs: string[][] = [];
    const git = async (args: readonly string[], cwd: string): Promise<string> => {
      gitArgs.push([...args]);
      return realGit(args, cwd);
    };
    const options = { ...optionsFor(repo, ['deliver-js', 'deliver-http'], (line) => writes.push(line)), git };
    const started = Date.now();
    const result = await runHidden(options);
    expect(Date.now() - started).toBeLessThan(90_000);
    expect(result.exitCode).toBe(0);
    expect(result.rows.map((row) => row.name)).toEqual(['deliver-js', 'deliver-http']);
    for (const row of result.rows) {
      expect(row.factory).toBe('exit 0');
      expect(row.delivered).toBe(true);
      expect(row.build?.ok).toBe(true);
      expect(row.ignored).toEqual([]);
      expect(row.startup?.ok).toBe(true);
    }
    expect(gitArgs.length).toBeGreaterThan(0);
    expect(gitArgs.every((args) => args[0] === 'ls-files')).toBe(true);
    expect(writes.join('\n')).toContain('Owner steps:');
    const report = readFileSync(join(repo, 'hidden', 'REPORT.md'), 'utf8');
    expect(report).toContain('[report](factory-trace/deliver-js/report.md)');
    expect(readFileSync(join(repo, 'hidden', 'factory-trace', 'deliver-http', 'report.md'), 'utf8')).toBe('# Run deliver-http-fake\n');
  }, 120_000);

  test('a factory killed at the hard deadline still prints the table', async () => {
    const repo = makeRepo();
    const writes: string[] = [];
    const started = Date.now();
    const options = { ...optionsFor(repo, ['hang'], (line) => writes.push(line)), hardDeadlineMs: started + 2_000, termGraceMs: 500 };
    const result = await runHidden(options);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.rows).toEqual([
      { name: 'hang', factory: 'killed at the hard deadline', delivered: false, build: null, ignored: [], startup: null },
    ]);
    expect(result.exitCode).toBe(1);
    expect(writes).toContain('[hang] the fake factory hangs now');
    expect(writes.join('\n')).toContain('killed at the hard deadline');
  }, 30_000);

  test('a factory that ignores SIGTERM is killed in time for the report, whatever the grace', async () => {
    const repo = makeRepo();
    const started = Date.now();
    const options = {
      ...optionsFor(repo, ['hang-ignoring-term'], () => undefined),
      hardDeadlineMs: started + 2_000,
      reportByMs: started + 4_000,
      termGraceMs: 30_000,
    };
    const result = await runHidden(options);
    expect(Date.now()).toBeLessThan(options.reportByMs + 1_000);
    expect(result.rows[0]?.factory).toBe('killed at the hard deadline');
  }, 45_000);

  test('a built delivery is committable and a missing import fails its startup', async () => {
    const repo = makeRepo();
    const writes: string[] = [];
    const result = await runHidden(optionsFor(repo, ['deliver-build', 'missing-import'], (line) => writes.push(line)));
    expect(result.exitCode).toBe(1);
    const [built, missing] = result.rows;
    expect(built?.build?.ok).toBe(true);
    expect(built?.ignored).toEqual([]);
    expect(built?.startup?.ok).toBe(true);
    expect(readFileSync(join(repo, 'hidden', 'deliver-build', '.gitignore'), 'utf8')).toBe('node_modules/\n');
    const committed = await realGit(['ls-files', '--others', '--exclude-standard', '--', 'hidden/deliver-build'], repo);
    const committedPaths = committed.split('\n');
    expect(committedPaths).toContain('hidden/deliver-build/dist/cli.js');
    expect(committedPaths).toContain('hidden/deliver-build/dist/commands.js');
    expect(missing?.startup?.ok).toBe(false);
    expect(missing?.startup?.detail).toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND/);
    expect(writes.join('\n')).toMatch(/missing-import .*failed: node cli\.js --help: the output names/);
    expect(writes.some((line) => line.startsWith('[missing-import] startup failed: node cli.js --help'))).toBe(true);
  }, 120_000);

  test('git listings that outlast the report time are bounded by it and reported as not checked', async () => {
    const repo = makeRepo();
    const writes: string[] = [];
    const now = Date.now();
    const bounds: number[] = [];
    const git = async (_args: readonly string[], _cwd: string, timeoutMs?: number): Promise<string> => {
      bounds.push(timeoutMs ?? Number.POSITIVE_INFINITY);
      await Bun.sleep(timeoutMs ?? 60_000);
      throw new Error('git timed out');
    };
    const options = {
      ...optionsFor(repo, ['deliver-js'], (line) => writes.push(line)),
      hardDeadlineMs: now + 8_000,
      reportByMs: now + 12_000,
      git,
    };
    const result = await runHidden(options);
    expect(Date.now()).toBeLessThan(options.reportByMs + 2_000);
    expect(bounds.every((bound) => bound <= 12_000)).toBe(true);
    expect(result.rows[0]?.delivered).toBe(true);
    expect(result.rows[0]?.ignored).toBeNull();
    expect(result.rows[0]?.startup).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(writes.join('\n')).toContain('not checked: report time');
  }, 30_000);

  test('a factory command that cannot start is named in its row', async () => {
    const repo = makeRepo();
    const options = { ...optionsFor(repo, ['deliver-js'], () => undefined), factoryCommand: [join(repo, 'no-such-factory')] };
    const result = await runHidden(options);
    expect(result.rows[0]?.factory).toStartWith('spawn failed: ');
    expect(result.rows[0]?.delivered).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  test('a bad time order fails before anything starts', async () => {
    const repo = makeRepo();
    const writes: string[] = [];
    const hard = Date.now() + 60_000;
    const options = { ...optionsFor(repo, ['deliver-js'], (line) => writes.push(line)), hardDeadlineMs: hard, reportByMs: hard };
    await expect(runHidden(options)).rejects.toThrow(/not after the hard deadline/);
    expect(writes).toEqual([]);
  });
});

describe('factoryCell', () => {
  const base = { exitCode: 0, timedOut: false, spawnFailure: null, stdout: '', stderr: '', elapsedMs: 1 };
  test('names the exit code, the hard-deadline kill and a spawn failure', () => {
    expect(factoryCell(base)).toBe('exit 0');
    expect(factoryCell({ ...base, exitCode: null, timedOut: true })).toBe('killed at the hard deadline');
    expect(factoryCell({ ...base, exitCode: null, spawnFailure: 'spawn failed: ENOENT' })).toBe('spawn failed: ENOENT');
  });
});

describe('parseTimes and parseCommandLine', () => {
  const now = new Date(2026, 9, 30, 18, 0, 0);

  test('the defaults are 19:15, 19:22, 19:26 and two tasks', () => {
    const parsed = parseCommandLine(['a.md', 'b.md'], now);
    expect(parsed.specPaths).toEqual([resolve('a.md'), resolve('b.md')]);
    expect(parsed.cutoff).toBe('19:15');
    expect(parsed.hardDeadlineMs).toBe(new Date(2026, 9, 30, 19, 22).getTime());
    expect(parsed.reportByMs).toBe(new Date(2026, 9, 30, 19, 26).getTime());
    expect(parsed.taskConcurrency).toBe(2);
    expect(parsed.replace).toBe(false);
  });

  test('every option is taken', () => {
    const parsed = parseCommandLine(
      ['a.md', '--cutoff', '18:20', '--hard-deadline', '18:25', '--report-by', '18:28', '--task-concurrency', '3'],
      now,
    );
    expect(parsed.cutoff).toBe('18:20');
    expect(parsed.hardDeadlineMs).toBe(new Date(2026, 9, 30, 18, 25).getTime());
    expect(parsed.taskConcurrency).toBe(3);
    expect(parseCommandLine(['a.md', '--replace'], now).replace).toBe(true);
  });

  test('no spec, an unknown option or a bad concurrency is an error', () => {
    expect(() => parseCommandLine([], now)).toThrow(/no spec/);
    expect(() => parseCommandLine(['a.md', '--deadline', '19:00'], now)).toThrow();
    expect(() => parseCommandLine(['a.md', '--task-concurrency', '0'], now)).toThrow();
  });

  test('the times must run cutoff, hard deadline, report time, all after now', () => {
    expect(() => parseTimes('19:22', '19:22', '19:26', now)).toThrow(/hard deadline 19:22 is not after the cutoff/);
    expect(() => parseTimes('19:15', '19:30', '19:26', now)).toThrow(/report time 19:26 is not after the hard deadline/);
    expect(() => parseTimes('17:00', '19:22', '19:26', now)).toThrow(/not after now/);
    expect(() => parseTimes('soon', '19:22', '19:26', now)).toThrow(/not a time/);
  });
});

describe('installInterrupt', () => {
  test('the first signal forwards SIGINT to every factory, the second kills all and exits 130', () => {
    const listeners = new Map<string, () => void>();
    const source = { on: (event: 'SIGINT' | 'SIGTERM', listener: () => void) => listeners.set(event, listener) };
    const emit = (event: 'SIGINT' | 'SIGTERM'): void => listeners.get(event)?.();
    const calls: string[] = [];
    installInterrupt(source, () => [11, 12], {
      forward: (pid) => calls.push(`forward ${String(pid)}`),
      killAll: () => calls.push('killAll'),
      exit: (code) => calls.push(`exit ${String(code)}`),
      write: () => undefined,
    });
    emit('SIGINT');
    expect(calls).toEqual(['forward 11', 'forward 12']);
    emit('SIGTERM');
    expect(calls).toEqual(['forward 11', 'forward 12', 'killAll', 'exit 130']);
  });
});
