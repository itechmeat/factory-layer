/**
 * The hidden run's transparency output: the run id is read from the
 * factory's stdout, each run's report and trace land in
 * `hidden/factory-trace/<name>/` (an earlier copy replaced), a run without
 * a report gets one rebuilt from its trace, and REPORT.md carries the table
 * and one line per spec, a spec without a run id included; a failed copy
 * is a returned outcome, never a throw.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { publishTrace, runIdOf, TRACE_DIR } from './hidden-run-trace';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A repo root with `runs/<runId>/` holding the given files, and its hidden dir. */
function aRepo(runs: Record<string, Record<string, string>>): { repoRoot: string; hiddenDir: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'hidden-trace-'));
  roots.push(repoRoot);
  for (const [runId, files] of Object.entries(runs)) {
    mkdirSync(join(repoRoot, 'runs', runId), { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(repoRoot, 'runs', runId, file), text);
  }
  return { repoRoot, hiddenDir: join(repoRoot, 'hidden') };
}

/** A factory command whose `report <runId>` writes the report the way `factory report` does. */
const REBUILDING_FACTORY = ['sh', '-c', 'mkdir -p "runs/$2" && echo rebuilt > "runs/$2/report.md"', 'factory'];

describe('runIdOf', () => {
  test('reads the first run id line of the factory output, never a later one an error message carries', () => {
    expect(runIdOf('starting\nrun id: wordfreq-20261031t180000z-ab12\nplan: 3 tasks\n')).toBe('wordfreq-20261031t180000z-ab12');
    expect(runIdOf('run id: a-1\nerror: boom\nrun id: ../../elsewhere\n')).toBe('a-1');
    expect(runIdOf('no id here\n')).toBeNull();
  });

  test('a first run id that is not a safe directory name is refused', () => {
    expect(runIdOf('run id: ../../etc\n')).toBeNull();
    expect(runIdOf('run id: a/b\n')).toBeNull();
  });
});

describe('publishTrace', () => {
  test('copies each report and trace next to the deliveries and links them from REPORT.md', async () => {
    const { repoRoot, hiddenDir } = aRepo({ 'wordfreq-1': { 'report.md': '# report', 'trace.jsonl': '{}\n' } });
    mkdirSync(join(hiddenDir, TRACE_DIR, 'wordfreq'), { recursive: true });
    writeFileSync(join(hiddenDir, TRACE_DIR, 'wordfreq', 'stale.txt'), 'old');
    await publishTrace(
      { repoRoot, hiddenDir, factoryCommand: REBUILDING_FACTORY, env: {}, deadlineMs: Date.now() + 60_000 },
      [
        { name: 'wordfreq', runId: 'wordfreq-1' },
        { name: 'notes-api', runId: null },
      ],
      'name  factory\nwordfreq  exit 0',
      ['[notes-api] build failed: no package.json'],
      new Date('2026-10-31T18:30:00Z'),
    );
    expect(readFileSync(join(hiddenDir, TRACE_DIR, 'wordfreq', 'report.md'), 'utf8')).toBe('# report');
    expect(readFileSync(join(hiddenDir, TRACE_DIR, 'wordfreq', 'trace.jsonl'), 'utf8')).toBe('{}\n');
    expect(existsSync(join(hiddenDir, TRACE_DIR, 'wordfreq', 'stale.txt'))).toBe(false);
    const report = readFileSync(join(hiddenDir, 'REPORT.md'), 'utf8');
    expect(report).toContain('2026-10-31T18:30:00.000Z');
    expect(report).toContain('wordfreq  exit 0');
    expect(report).toContain('[notes-api] build failed: no package.json');
    expect(report).toContain(
      '1. `wordfreq`: run `wordfreq-1`, [report](factory-trace/wordfreq/report.md), [trace](factory-trace/wordfreq/trace.jsonl).',
    );
    expect(report).toContain('2. `notes-api`: the factory printed no run id, so there is no report or trace.');
  });

  test('a run killed before its report gets one rebuilt from its trace', async () => {
    const { repoRoot, hiddenDir } = aRepo({ 'units-1': { 'trace.jsonl': '{}\n' } });
    await publishTrace(
      { repoRoot, hiddenDir, factoryCommand: REBUILDING_FACTORY, env: {}, deadlineMs: Date.now() + 60_000 },
      [{ name: 'units', runId: 'units-1' }],
      't',
      [],
      new Date(),
    );
    expect(readFileSync(join(hiddenDir, TRACE_DIR, 'units', 'report.md'), 'utf8')).toBe('rebuilt\n');
  });

  test('a copy that cannot be written is reported, not thrown', async () => {
    const { repoRoot } = aRepo({ 'x-1': { 'report.md': 'r' } });
    const blocked = join(repoRoot, 'hidden-is-a-file');
    writeFileSync(blocked, 'not a directory');
    const options = { repoRoot, hiddenDir: blocked, factoryCommand: ['true'], env: {}, deadlineMs: Date.now() + 60_000 };
    const outcome = await publishTrace(options, [{ name: 'x', runId: 'x-1' }], 't', [], new Date());
    expect(outcome.ok).toBe(false);
  });

  test('a run with no files is named with what is missing', async () => {
    const { repoRoot, hiddenDir } = aRepo({});
    await publishTrace(
      { repoRoot, hiddenDir, factoryCommand: ['true'], env: {}, deadlineMs: Date.now() + 60_000 },
      [{ name: 'gone', runId: 'gone-1' }],
      't',
      [],
      new Date(),
    );
    expect(readFileSync(join(hiddenDir, 'REPORT.md'), 'utf8')).toContain(
      '1. `gone`: run `gone-1`, nothing to link; missing: report.md, trace.jsonl.',
    );
  });
});
